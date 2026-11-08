/**
 * Blur Web — standalone retail damage rules.
 *
 * Host-authoritative, deterministic, no engine and no game-data import: the
 * caller passes the recovered manifest (`_work/damage/damage.json`).
 *
 * Every numeric rule comes from `manifest`; the source of each value is labelled
 * in the manifest (`data` / `code` / `provisional`).  Nothing here is a guessed
 * curve: impacts consume the normalised gameplay impulse exactly as
 * `C_VehicleComponent_Damage::HandleImpact` does, and perks consume the
 * serialized `DamageInflicted` exactly as `GetDamageInflicted` does.
 *
 * References (retail source, line numbers in manifest.sourceCode.citations):
 *   VLC_Damage.cpp: AdjustHealth 514-737, ApplyDamage 785-812,
 *     GetDamageInflicted 2258-2340, HandleImpact 1725-1874,
 *     ApplyDamageMultiplier 1235-1257, GetDamagePointsFromImpactLevel 1073-1093
 *   RaceLogicLayer.cpp: CalculateImpactLevel 3235-3257, gameplay impulse 2235-2384
 *   VehicleLogicActor.cpp: CalcMaxHealth 1558-1583, ResetHealth 1773-1788
 *   PickupBase.cpp: CheckCanHit 203-213
 *   VLC_Pickups.cpp: AttemptHitByPickup 1625-1637, shield/ram 2277-2343
 *   PickupShield.cpp 40-164, PickupSuperShield.cpp 26-195
 */

export const DAMAGE_SCHEMA_VERSION = 1;

const IMPACT_CONTACTS = {
  vehicle: 'dynamic',
  'dynamic-object': 'dynamic',
  object: 'dynamic',
  dynamic: 'dynamic',
  world: 'static',
  static: 'static',
};

const SUB_TYPE_LEVEL = {
  NORMAL: 'Normal',
  DOUBLE_TAP: 'DoubleTap',
  DOUBLE: 'DoubleTap',
  REVERSED: 'Reversed',
  REVERSED_DOUBLE_TAP: 'ReversedDoubleTap',
  MINI: 'Mini',
  MODIFIED: 'Modified',
  MOD: 'Modified',
  DECOY: 'Decoy',
};

const INTERNAL_MODE = {
  normal: { kind: 'normal', multiplier: 1 },
  off: { kind: 'invulnerable', multiplier: 0 },
  invulnerable: { kind: 'invulnerable', multiplier: 0 },
  low: { kind: 'multiplier', multiplier: 0.5 },
  medium: { kind: 'multiplier', multiplier: 1 },
  high: { kind: 'multiplier', multiplier: 2 },
  'one-hit': { kind: 'one-shot', multiplier: null },
  one_hit: { kind: 'one-shot', multiplier: null },
  onehit: { kind: 'one-shot', multiplier: null },
  'powerups-only': { kind: 'powerups-only', multiplier: 1 },
  powerups_only: { kind: 'powerups-only', multiplier: 1 },
};

const DEFAULT_MODE_BY_MODE = {
  racing: 'medium',
  elimination: 'medium',
  destruction: 'powerups-only',
  'single-player': 'normal',
  custom: 'normal',
};

const DEFAULT_WRECK_BEHAVIOUR = {
  destruction: 'do-nothing',
  elimination: 'eliminate',
  racing: 'respawn',
  'single-player': 'respawn',
  custom: 'respawn',
};

export class DamageError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'DamageError';
    this.detail = detail ?? null;
  }
}

function assert(condition, message, detail) {
  if (!condition) throw new DamageError(message, detail);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function validateManifest(manifest) {
  assert(manifest && typeof manifest === 'object', 'manifest-required');
  assert(manifest.kind === 'damage-model.recovery', 'manifest-kind', manifest.kind);
  assert(manifest.version === DAMAGE_SCHEMA_VERSION, 'manifest-version', manifest.version);
  for (const key of ['health', 'impact', 'perk', 'shield', 'wreck', 'modes']) {
    assert(manifest[key] && typeof manifest[key] === 'object', `manifest-section:${key}`);
  }
  assert(Array.isArray(manifest.health.zones) && manifest.health.zones.length > 0, 'manifest-health-zones');
  assert(Array.isArray(manifest.health.groups) && manifest.health.groups.length > 0, 'manifest-health-groups');
  assert(Array.isArray(manifest.impact.types) && manifest.impact.types.length > 0, 'manifest-impact-types');
  assert(isFiniteNumber(manifest.impact.normalisation.dynamicDynamic), 'manifest-impact-range');
  assert(isFiniteNumber(manifest.impact.normalisation.static), 'manifest-impact-range-static');
  assert(isFiniteNumber(manifest.impact.massNormalisation.referenceMassKg), 'manifest-mass-reference');
  assert(isFiniteNumber(manifest.health.increment) && manifest.health.increment > 0, 'manifest-health-increment');
  assert(manifest.perk.weapons && typeof manifest.perk.weapons === 'object', 'manifest-weapons');
}

export function createDamageWorld(manifest, options = {}) {
  validateManifest(manifest);

  const tickRate = options.tickRate ?? 60;
  assert(Number.isInteger(tickRate) && tickRate > 0 && tickRate <= 1000, 'tickRate', tickRate);

  const authorityId = options.authorityId ?? 'host';
  const mode = options.mode ?? 'racing';
  const modeKey = DEFAULT_MODE_BY_MODE[mode] !== undefined ? mode : 'custom';
  const damageModeName = options.damageMode ?? DEFAULT_MODE_BY_MODE[modeKey] ?? 'normal';
  const modeRule = INTERNAL_MODE[damageModeName];
  assert(modeRule, 'unsupported-damage-mode', damageModeName);
  const wreckBehaviour = options.wreckBehaviour ?? DEFAULT_WRECK_BEHAVIOUR[modeKey] ?? 'respawn';
  assert(['respawn', 'eliminate', 'do-nothing'].includes(wreckBehaviour), 'wreckBehaviour', wreckBehaviour);

  const motorMash = options.motorMash
    ?? (manifest.perk.motorMashApplies ?? []).includes(modeKey);
  const halfPip = Math.trunc(manifest.health.increment / 2);
  const startHealthPolicy = manifest.health.startHealth;

  const healthIncrement = manifest.health.increment;
  const bases = new Map(manifest.health.groups.map((g) => [g.group, g.baseHealth]));
  const zones = manifest.health.zones
    .slice()
    .sort((a, b) => a.min - b.min);

  const impactTypes = manifest.impact.types.map((t) => ({
    level: t.level,
    front: { ...t.front },
    side: { ...t.side },
  }));
  const impactDamage = { ...manifest.impact.damage };

  const weaponTable = new Map();
  for (const [type, entry] of Object.entries(manifest.perk.weapons)) {
    weaponTable.set(type, entry.levels ?? {});
  }

  const minorHalving = new Set(manifest.perk.minorHalving ?? []);
  const harmfulTypes = new Set(manifest.perk.harmfulTypes ?? []);

  const shieldCfg = manifest.shield;
  const shieldLevels = {
    shield: { level: 'Normal', lifetime: shieldCfg.normal.lifetime, health: shieldCfg.normal.health, ramActive: Boolean(shieldCfg.normal.ramActive) },
    'shield-double': { level: 'DoubleTap', lifetime: shieldCfg.doubleTap.lifetime, health: shieldCfg.doubleTap.health, ramActive: Boolean(shieldCfg.doubleTap.ramActive) },
    supershield: { level: 'Normal', lifetime: shieldCfg.superShield.lifetime, health: null, ramActive: Boolean(shieldCfg.superShield.ramActive) },
  };

  const wreckTicks = Math.round(manifest.wreck.durationSeconds * tickRate);
  const ghostAfterRespawnTicks = Math.round(manifest.wreck.ghostAfterRespawnSeconds * tickRate);
  const wreckedGhostTicks = Math.round(manifest.wreck.ghostFromWreckSeconds * tickRate);
  const impactCooldownTicks = Math.round(manifest.impact.cooldownSeconds * tickRate);
  const perkCooldownTicks = Math.round(manifest.perk.cooldownSeconds * tickRate);
  const ramCooldownTicks = Math.round(shieldCfg.ramCooldownSeconds * tickRate);
  const nitroDurationTicks = Math.round((shieldCfg.nitroDuration ?? 0) * tickRate);

  const cars = new Map();
  const events = [];
  let tick = 0;
  let seq = 0;
  let lastCommandSeq = 0;
  let enabled = false;
  let started = false;

  function emit(type, payload = {}) {
    seq += 1;
    const event = {
      seq,
      type,
      at: tick,
      atSeconds: round6(tick / tickRate),
      authority: authorityId,
      ...payload,
    };
    events.push(event);
    if (events.length > 2048) events.splice(0, events.length - 2048);
    return event;
  }

  function reject(reason, command, extra = {}) {
    return emit('command-rejected', {
      reason,
      command: command?.type ?? null,
      commandSeq: command?.seq ?? null,
      ...extra,
    });
  }

  function levelFor(health) {
    for (const zone of zones) {
      if (health > zone.min && health <= zone.max) return zone.zone;
    }
    return zones.length ? zones[zones.length - 1].zone : 'HighHealth';
  }

  function compatLevel(zoneName) {
    switch (zoneName) {
      case 'Wrecked': return 'Wrecked';
      case 'LowHealth': return 'Low';
      case 'MediumHealth': return 'Medium';
      case 'HighHealth': return 'High';
      default: return zoneName;
    }
  }

  function requireCar(id, command) {
    const car = cars.get(id);
    if (!car) {
      reject('no-such-car', command, { targetId: id ?? null });
      return null;
    }
    return car;
  }

  function maxHealthFor(healthGroup, healthOverride, additionalHealthSlots) {
    if (isFiniteNumber(healthOverride) && healthOverride > 0) return Math.trunc(healthOverride);
    const base = bases.get(healthGroup);
    assert(base !== undefined, 'unknown-health-group', healthGroup);
    return Math.trunc(base) + healthIncrement * (additionalHealthSlots ?? 0);
  }

  function addCar(id, config = {}) {
    assert(typeof id === 'string' && id.length > 0, 'car-id', id);
    assert(!cars.has(id), 'duplicate-car', id);
    const healthGroup = config.healthGroup ?? 'Low';
    const maxHealth = maxHealthFor(
      healthGroup,
      config.healthOverride ?? 0,
      config.additionalHealthSlots ?? options.additionalHealthSlots ?? 0,
    );
    const car = {
      id,
      healthGroup,
      maxHealth,
      health: maxHealth - 1,
      healthLevel: compatLevel(levelFor(maxHealth - 1)),
      wrecked: false,
      eliminated: false,
      wreckRemaining: 0,
      ghostRemaining: 0,
      cooldownRemaining: 0,
      ramCooldownRemaining: 0,
      shield: null,
      effects: [],
      massKg: isFiniteNumber(config.massKg) ? config.massKg : null,
      position: config.position ?? null,
      damageTaken: 0,
      damageDealt: 0,
      repairsReceived: 0,
      hits: 0,
      wrecks: 0,
      respawns: 0,
      startHealthPolicy,
    };
    cars.set(id, car);
    emit('car-entered', {
      targetId: id,
      maxHealth,
      health: car.health,
      healthGroup,
      healthLevel: car.healthLevel,
      additionalHealthSlots: config.additionalHealthSlots ?? options.additionalHealthSlots ?? 0,
      startHealth: startHealthPolicy,
    });
    return car;
  }

  function startRace() {
    if (started) return;
    started = true;
    enabled = true;
    emit('race-started', { mode: modeKey, damageMode: damageModeName, wreckBehaviour });
  }

  function halfPipFloor(damage) {
    if (!motorMash || halfPip <= 0) return damage;
    const adjustment = damage % halfPip;
    return adjustment > 0 ? damage - adjustment : damage;
  }

  function shieldActive(car) {
    return Boolean(car.shield && car.shield.remainingTicks > 0);
  }

  function breakShield(car, reason) {
    if (!car.shield) return;
    const broken = {
      kind: car.shield.kind,
      level: car.shield.level,
      healthRemaining: car.shield.health,
      remainingSeconds: round6(car.shield.remainingTicks / tickRate),
    };
    car.shield = null;
    emit('shield-broken', { targetId: car.id, reason, ...broken });
  }

  function activateShield(car, kind, level) {
    const cfg = kind === 'supershield'
      ? shieldLevels.supershield
      : level === 'DoubleTap'
        ? shieldLevels['shield-double']
        : shieldLevels.shield;
    const key = kind === 'supershield' ? 'supershield' : cfg.level === 'DoubleTap' ? 'shield-double' : 'shield';
    const kindName = kind === 'supershield' ? 'SuperShield' : 'Shield';

    if (shieldActive(car) && kind === 'supershield' && car.shield.kind === 'supershield') {
      emit('shield-replaced', {
        targetId: car.id,
        kind: kindName,
        refreshed: false,
        remainingSeconds: round6(car.shield.remainingTicks / tickRate),
      });
      return;
    }
    const refresh = shieldActive(car);
    car.shield = {
      kind: key,
      kindName,
      level: cfg.level,
      remainingTicks: Math.round(cfg.lifetime * tickRate),
      health: cfg.health,
      ramActive: cfg.ramActive,
    };
    emit('shield-activated', {
      targetId: car.id,
      kind: kindName,
      level: cfg.level,
      lifetimeSeconds: cfg.lifetime,
      health: cfg.health,
      remainingSeconds: round6(car.shield.remainingTicks / tickRate),
      ramActive: cfg.ramActive,
      refresh,
      absorbModel: shieldCfg.absorbModel,
    });
  }

  function applyShieldDrain(car, sourceType) {
    if (!car.shield || car.shield.health === null) return;
    let drain = 0;
    if (sourceType === 'Shock') drain = shieldCfg.shockDrainDamage;
    if (!drain) return;
    car.shield.health -= drain;
    emit('shield-health-drained', {
      targetId: car.id,
      sourceType,
      amount: drain,
      remaining: car.shield.health,
      shieldKind: car.shield.kindName,
    });
    if (car.shield.health <= 0) breakShield(car, 'drained');
  }

  function wreck(car, sourceId, sourceKind) {
    car.wrecked = true;
    car.wrecks += 1;
    car.wreckRemaining = wreckTicks;
    car.ghostRemaining = Math.max(car.ghostRemaining, wreckedGhostTicks);
    car.healthLevel = 'Wrecked';
    emit('wrecked', {
      targetId: car.id,
      sourceId: sourceId ?? null,
      source: sourceKind,
      health: car.health,
      wreckSeconds: round6(wreckTicks / tickRate),
      ghostSeconds: round6(car.ghostRemaining / tickRate),
      ghostFromWreck: true,
      behaviour: wreckBehaviour,
    });
    if (wreckBehaviour === 'eliminate') {
      car.eliminated = true;
      emit('eliminated', { targetId: car.id, sourceId: sourceId ?? null, source: sourceKind, wreckSeconds: round6(wreckTicks / tickRate) });
    }
  }

  function applyDamage(car, amount, meta) {
    assert(Number.isInteger(amount) && amount >= 0, 'damage-int', amount);
    const before = car.health;
    const beforeLevel = car.healthLevel;
    car.health -= amount;
    if (amount !== 0 && car.health < 0) car.health = 0;
    if (car.health >= car.maxHealth) car.health = car.maxHealth - 1;
    car.healthLevel = compatLevel(levelFor(car.health));
    if (amount > 0) {
      car.damageTaken += amount;
      car.hits += 1;
      const attacker = meta.sourceId ? cars.get(meta.sourceId) : null;
      if (attacker && meta.sourceId !== car.id) attacker.damageDealt += amount;
    }
    const overkill = amount > before ? before : 0;
    emit('damage-applied', {
      targetId: car.id,
      sourceId: meta.sourceId ?? null,
      source: meta.source,
      pickupType: meta.pickupType ?? null,
      hitType: meta.hitType ?? null,
      impactLevel: meta.impactLevel ?? null,
      rawDamage: meta.rawDamage ?? amount,
      appliedDamage: amount,
      overkill,
      healthBefore: before,
      healthAfter: car.health,
      healthLevelBefore: beforeLevel,
      healthLevelAfter: car.healthLevel,
      multiplier: meta.multiplier ?? null,
      massScaledImpulse: meta.massScaledImpulse ?? null,
    });
    if (car.healthLevel === 'Wrecked' && !car.wrecked) {
      wreck(car, meta.sourceId ?? null, meta.source);
    }
    return amount;
  }

  function ignore(car, reason, meta = {}) {
    emit('damage-ignored', {
      targetId: car.id,
      sourceId: meta.sourceId ?? null,
      source: meta.source ?? null,
      pickupType: meta.pickupType ?? null,
      reason,
    });
  }

  function impact(car, command) {
    const raw = command.rawImpulseNs;
    assert(isFiniteNumber(raw) && raw >= 0, 'impact-rawImpulseNs', raw);
    const contact = IMPACT_CONTACTS[command.contact ?? 'vehicle'];
    assert(contact, 'impact-contact', command.contact);
    if (!enabled) return ignore(car, 'not-started', { sourceId: command.sourceId, source: 'impact' });
    if (modeRule.kind === 'invulnerable') return ignore(car, 'invulnerable', { sourceId: command.sourceId, source: 'impact' });
    if (modeRule.kind === 'powerups-only') return ignore(car, 'powerups-only', { sourceId: command.sourceId, source: 'impact' });
    if (car.eliminated) return ignore(car, 'eliminated', { sourceId: command.sourceId, source: 'impact' });
    if (car.wrecked) return ignore(car, 'wrecked', { sourceId: command.sourceId, source: 'impact' });
    if (car.ghostRemaining > 0) return ignore(car, 'ghost', { sourceId: command.sourceId, source: 'impact' });
    if (shieldActive(car)) return ignore(car, 'shield', { sourceId: command.sourceId, source: 'impact' });
    if (car.cooldownRemaining > 0) return ignore(car, 'cooldown', { sourceId: command.sourceId, source: 'impact' });
    if (!isFiniteNumber(car.massKg) && !isFiniteNumber(command.massKg)) {
      return reject('missing-mass', command, { targetId: car.id });
    }
    const massKg = isFiniteNumber(command.massKg) ? command.massKg : car.massKg;
    assert(massKg > 0, 'impact-mass', massKg);

    const range = contact === 'dynamic'
      ? manifest.impact.normalisation.dynamicDynamic
      : manifest.impact.normalisation.static;
    const gameplayImpulse = Math.min(1, Math.max(0, raw / range));
    const scaled = gameplayImpulse * (manifest.impact.massNormalisation.referenceMassKg / massKg);
    const side = Boolean(command.isSideImpact);
    let level = null;
    for (const type of impactTypes) {
      const bounds = side ? type.side : type.front;
      if (scaled > bounds.min && scaled <= bounds.max) {
        level = type.level;
        break;
      }
    }
    if (!level) {
      emit('impact-below-threshold', {
        targetId: car.id,
        sourceId: command.sourceId ?? null,
        gameplayImpulse: round6(gameplayImpulse),
        massScaledImpulse: round6(scaled),
        contact,
        isSideImpact: side,
        massKg,
      });
      return;
    }
    let damage = impactDamage[level] ?? 0;
    let multiplier = null;
    if (modeRule.kind === 'multiplier' && modeRule.multiplier !== 1) {
      multiplier = modeRule.multiplier;
      damage = Math.trunc(damage * multiplier);
    }
    const floored = halfPipFloor(damage);
    emit('impact-classified', {
      targetId: car.id,
      sourceId: command.sourceId ?? null,
      impactLevel: level,
      gameplayImpulse: round6(gameplayImpulse),
      massScaledImpulse: round6(scaled),
      contact,
      isSideImpact: side,
      massKg,
      rawDamage: damage,
      appliedDamage: floored,
      cooldownSeconds: round6(impactCooldownTicks / tickRate),
    });
    car.cooldownRemaining = impactCooldownTicks;
    if (floored > 0) {
      applyDamage(car, floored, {
        sourceId: command.sourceId,
        source: 'impact',
        impactLevel: level,
        rawDamage: damage,
        multiplier,
        massScaledImpulse: round6(scaled),
      });
    }
  }

  function resolveWeaponDamage(car, type, level, hitType) {
    const rows = weaponTable.get(type);
    assert(rows, 'unsupported-pickup', type);
    const row = rows[level] ?? rows.Normal;
    const harmful = harmfulTypes.has(type);
    if (modeRule.kind === 'one-shot' && harmful) {
      return { damage: car.maxHealth, base: car.maxHealth, source: 'one-shot' };
    }
    let base = isFiniteNumber(row?.damageInflicted) ? row.damageInflicted : 0;
    if (hitType === 'minor' && minorHalving.has(type)) base = Math.trunc(base / 2);
    let damage = base;
    let multiplier = null;
    if (modeRule.kind === 'multiplier' && harmful && modeRule.multiplier !== 1) {
      multiplier = modeRule.multiplier;
      damage = Math.trunc(damage * multiplier);
    }
    return { damage: halfPipFloor(damage), base, multiplier };
  }

  function weaponHit(car, command) {
    const type = command.pickupType;
    assert(typeof type === 'string' && type.length > 0, 'weapon-pickupType', type);
    if (type === 'Repair') return repair(car, command);
    if (type === 'Shield' || type === 'SuperShield') {
      reject('not-a-damage-weapon', command, { targetId: car.id, pickupType: type });
      return;
    }
    if (!enabled) return ignore(car, 'not-started', { sourceId: command.sourceId, source: 'weapon', pickupType: type });
    if (modeRule.kind === 'invulnerable') return ignore(car, 'invulnerable', { sourceId: command.sourceId, source: 'weapon', pickupType: type });
    if (car.eliminated) return ignore(car, 'eliminated', { sourceId: command.sourceId, source: 'weapon', pickupType: type });
    if (car.wrecked) return ignore(car, 'wrecked', { sourceId: command.sourceId, source: 'weapon', pickupType: type });
    if (car.ghostRemaining > 0) return ignore(car, 'ghost', { sourceId: command.sourceId, source: 'weapon', pickupType: type });

    const level = SUB_TYPE_LEVEL[command.subType] ?? command.level ?? 'Normal';
    const hitType = command.hitType ?? 'major';

    if (shieldActive(car) && type !== 'Nitrous') {
      const resolved = resolveWeaponDamage(car, type, level, hitType);
      emit('shield-absorbed', {
        targetId: car.id,
        sourceId: command.sourceId ?? null,
        sourceType: type,
        hitType,
        attemptedBaseDamage: resolved.base,
        appliedDamage: 0,
        shieldKind: car.shield.kindName,
        shieldRemainingSeconds: round6(car.shield.remainingTicks / tickRate),
        shieldHealthRemaining: car.shield.health,
        absorbModel: shieldCfg.absorbModel,
        nitrousBypass: false,
      });
      applyShieldDrain(car, type);
      return;
    }

    const resolved = resolveWeaponDamage(car, type, level, hitType);
    car.cooldownRemaining = perkCooldownTicks;
    if (resolved.damage <= 0) {
      emit('damage-applied', {
        targetId: car.id,
        sourceId: command.sourceId ?? null,
        source: 'weapon',
        pickupType: type,
        hitType,
        level,
        rawDamage: resolved.base,
        appliedDamage: 0,
        overkill: 0,
        healthBefore: car.health,
        healthAfter: car.health,
        healthLevelBefore: car.healthLevel,
        healthLevelAfter: car.healthLevel,
        multiplier: resolved.multiplier,
        massScaledImpulse: null,
      });
      return;
    }
    applyDamage(car, resolved.damage, {
      sourceId: command.sourceId,
      source: 'weapon',
      pickupType: type,
      hitType,
      rawDamage: resolved.base,
      multiplier: resolved.multiplier,
    });
  }

  function repair(car, command) {
    const requested = isFiniteNumber(command.amount)
      ? Math.trunc(command.amount)
      : manifest.repair.amount;
    assert(Number.isInteger(requested) && requested >= 0, 'repair-amount', requested);
    if (car.eliminated) return ignore(car, 'eliminated', { sourceId: command.sourceId, source: 'repair', pickupType: 'Repair' });
    if (car.wrecked) {
      emit('repair-rejected', { targetId: car.id, sourceId: command.sourceId ?? null, reason: 'wrecked', requested });
      return;
    }
    const before = car.health;
    if (requested === 0) {
      car.health = car.maxHealth - 1;
    } else {
      car.health += requested;
      if (car.health >= car.maxHealth) car.health = car.maxHealth - 1;
    }
    const applied = car.health - before;
    car.healthLevel = compatLevel(levelFor(car.health));
    car.repairsReceived += applied;
    emit('repaired', {
      targetId: car.id,
      sourceId: command.sourceId ?? null,
      requested,
      applied,
      wasted: requested === 0 ? 0 : requested - applied,
      healthBefore: before,
      healthAfter: car.health,
      healthLevel: car.healthLevel,
      maxHealth: car.maxHealth,
    });
  }

  function ram(car, command) {
    const rammer = requireCar(command.rammerId, command);
    if (!rammer) return;
    if (!enabled) return ignore(car, 'not-started', { sourceId: rammer.id, source: 'ram' });
    if (modeRule.kind === 'invulnerable') return ignore(car, 'invulnerable', { sourceId: rammer.id, source: 'ram' });
    if (car.wrecked) return ignore(car, 'wrecked', { sourceId: rammer.id, source: 'ram' });
    if (car.ghostRemaining > 0) return ignore(car, 'ghost', { sourceId: rammer.id, source: 'ram' });
    const rammerShield = shieldActive(rammer) && rammer.shield.ramActive;
    if (!rammerShield) {
      emit('ram-ignored', { targetId: car.id, rammerId: rammer.id, reason: 'rammer-not-double-or-super-shielded' });
      return;
    }
    if (shieldActive(car) && car.shield.ramActive) {
      emit('ram-ignored', { targetId: car.id, rammerId: rammer.id, reason: 'both-shielded' });
      return;
    }
    if (car.ramCooldownRemaining > 0) {
      emit('ram-ignored', {
        targetId: car.id,
        rammerId: rammer.id,
        reason: 'cooldown',
        cooldownRemainingSeconds: round6(car.ramCooldownRemaining / tickRate),
      });
      return;
    }
    car.ramCooldownRemaining = ramCooldownTicks;
    const isSuper = rammer.shield.kind === 'supershield';
    emit('ram', {
      targetId: car.id,
      rammerId: rammer.id,
      rammerShield: rammer.shield.kindName,
      damage: isSuper ? shieldCfg.superShield.ramDamage : 0,
      cooldownSeconds: round6(ramCooldownTicks / tickRate),
      forceDamage: isSuper,
    });
    if (isSuper) {
      applyDamage(car, shieldCfg.superShield.ramDamage, {
        sourceId: rammer.id,
        source: 'ram',
        pickupType: 'SuperShield',
      });
    }
  }

  function applyEffect(car, command) {
    const kind = command.kind ?? 'nitro';
    let seconds = command.seconds;
    if (!isFiniteNumber(seconds)) {
      seconds = kind === 'nitro' ? (shieldCfg.nitroDuration ?? 0) : 0;
    }
    assert(isFiniteNumber(seconds) && seconds >= 0, 'effect-seconds', seconds);
    const remainingTicks = Math.round(seconds * tickRate);
    car.effects.push({ kind, remainingTicks, source: command.source ?? 'timer-only' });
    emit('effect-applied', {
      targetId: car.id,
      kind,
      durationSeconds: round6(remainingTicks / tickRate),
      source: command.source ?? 'timer-only',
      forceModelled: false,
    });
  }

  function advance(dtSeconds) {
    assert(isFiniteNumber(dtSeconds) && dtSeconds > 0, 'advance-dt', dtSeconds);
    const rawTicks = dtSeconds * tickRate;
    const ticks = Math.round(rawTicks);
    assert(Math.abs(rawTicks - ticks) <= 1e-6, 'advance-not-tick-aligned', { dtSeconds, tickRate });
    for (let i = 0; i < ticks; i += 1) stepOneTick();
  }

  function stepOneTick() {
    tick += 1;
    for (const car of cars.values()) {
      if (car.cooldownRemaining > 0) car.cooldownRemaining -= 1;
      if (car.ramCooldownRemaining > 0) car.ramCooldownRemaining -= 1;
      if (car.ghostRemaining > 0) car.ghostRemaining -= 1;

      if (car.shield) {
        car.shield.remainingTicks -= 1;
        if (car.shield.remainingTicks <= 0) {
          emit('shield-expired', {
            targetId: car.id,
            kind: car.shield.kindName,
            level: car.shield.level,
            healthRemaining: car.shield.health,
          });
          car.shield = null;
        }
      }

      if (car.effects.length) {
        const live = [];
        for (const effect of car.effects) {
          effect.remainingTicks -= 1;
          if (effect.remainingTicks <= 0) {
            emit('effect-expired', { targetId: car.id, kind: effect.kind, source: effect.source });
          } else {
            live.push(effect);
          }
        }
        car.effects = live;
      }

      if (car.wrecked && !car.eliminated && car.wreckRemaining > 0) {
        car.wreckRemaining -= 1;
        if (car.wreckRemaining === 0) {
          if (wreckBehaviour === 'respawn') respawn(car);
          else emit('wreck-timer-expired', { targetId: car.id, action: wreckBehaviour });
        }
      }
    }
  }

  function resolveRespawnTarget(car) {
    const provider = options.respawnTarget;
    if (typeof provider === 'function') {
      try {
        const target = provider(car.id, snapshotCar(car));
        if (target) return { policy: 'caller-supplied', ...target };
      } catch (error) {
        return { status: 'caller-error', message: String(error && error.message ? error.message : error) };
      }
      return { status: 'caller-required' };
    }
    if (provider && typeof provider === 'object') return { policy: 'caller-supplied', ...provider };
    return { status: 'caller-required' };
  }

  function respawn(car) {
    car.health = car.maxHealth - 1;
    car.healthLevel = compatLevel(levelFor(car.health));
    car.wrecked = false;
    car.wreckRemaining = 0;
    car.ghostRemaining = Math.max(car.ghostRemaining, ghostAfterRespawnTicks);
    car.cooldownRemaining = 0;
    car.respawns += 1;
    emit('respawn', {
      targetId: car.id,
      health: car.health,
      maxHealth: car.maxHealth,
      healthLevel: car.healthLevel,
      ghostSeconds: round6(car.ghostRemaining / tickRate),
      healthPolicy: manifest.wreck.respawnHealth.status,
      healthPolicyValue: manifest.wreck.respawnHealth.policy,
      target: resolveRespawnTarget(car),
    });
  }

  function dispatch(command) {
    switch (command.type) {
      case 'impact': {
        const car = requireCar(command.targetId, command);
        if (car) impact(car, command);
        return;
      }
      case 'weapon-hit': {
        const car = requireCar(command.targetId, command);
        if (car) weaponHit(car, command);
        return;
      }
      case 'repair': {
        const car = requireCar(command.targetId, command);
        if (car) repair(car, command);
        return;
      }
      case 'activate-shield': {
        const car = requireCar(command.targetId, command);
        if (!car) return;
        if (car.eliminated) {
          ignore(car, 'eliminated', { source: 'shield', pickupType: 'Shield' });
          return;
        }
        activateShield(car, command.kind ?? 'shield', command.level ?? 'Normal');
        return;
      }
      case 'ram': {
        const car = requireCar(command.targetId, command);
        if (car) ram(car, command);
        return;
      }
      case 'effect': {
        const car = requireCar(command.targetId, command);
        if (car) applyEffect(car, command);
        return;
      }
      case 'set-damage-mode': {
        const next = INTERNAL_MODE[command.damageMode];
        if (!next) {
          reject('unsupported-damage-mode', command, { damageMode: command.damageMode });
          return;
        }
        modeRule.kind = next.kind;
        modeRule.multiplier = next.multiplier;
        emit('damage-mode-changed', { damageMode: command.damageMode, engine: manifest.perk.damageModes[command.damageMode]?.engine ?? null });
        return;
      }
      default:
        reject('unknown-command', command);
    }
  }

  function apply(commands) {
    assert(Array.isArray(commands), 'apply-commands-array');
    const accepted = [];
    for (const command of commands) {
      if (!command || typeof command !== 'object') {
        reject('invalid-command', command);
        continue;
      }
      if (!Number.isInteger(command.seq) || command.seq <= lastCommandSeq) {
        reject('out-of-order', command, { lastCommandSeq });
        continue;
      }
      lastCommandSeq = command.seq;
      dispatch(command);
      accepted.push(command.seq);
    }
    return accepted;
  }

  function commandBase(extra) {
    lastCommandSeq += 1;
    return { seq: lastCommandSeq, ...extra };
  }

  function snapshotCar(car) {
    const fullSegments = Math.floor(car.health / healthIncrement);
    const remainder = car.health % healthIncrement;
    return {
      id: car.id,
      health: car.health,
      maxHealth: car.maxHealth,
      healthLevel: car.healthLevel,
      healthGroup: car.healthGroup,
      healthSegments: {
        full: fullSegments,
        remainder,
        max: Math.floor(car.maxHealth / healthIncrement),
        increment: healthIncrement,
      },
      wrecked: car.wrecked,
      eliminated: car.eliminated,
      wreckRemainingSeconds: round6(car.wreckRemaining / tickRate),
      ghostRemainingSeconds: round6(car.ghostRemaining / tickRate),
      cooldownRemainingSeconds: round6(car.cooldownRemaining / tickRate),
      ramCooldownRemainingSeconds: round6(car.ramCooldownRemaining / tickRate),
      shield: car.shield
        ? {
          kind: car.shield.kindName,
          level: car.shield.level,
          remainingSeconds: round6(car.shield.remainingTicks / tickRate),
          health: car.shield.health,
          ramActive: car.shield.ramActive,
        }
        : null,
      effects: car.effects.map((e) => ({
        kind: e.kind,
        remainingSeconds: round6(e.remainingTicks / tickRate),
        source: e.source,
      })),
      massKg: car.massKg,
      position: car.position,
      stats: {
        damageTaken: car.damageTaken,
        damageDealt: car.damageDealt,
        repairsReceived: car.repairsReceived,
        hits: car.hits,
        wrecks: car.wrecks,
        respawns: car.respawns,
      },
    };
  }

  function snapshot() {
    const list = [...cars.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return {
      authority: authorityId,
      mode: modeKey,
      damageMode: damageModeName,
      wreckBehaviour,
      tick,
      tickRate,
      started,
      enabled,
      cars: list.map(snapshotCar),
      labels: {
        healthStart: startHealthPolicy,
        respawnHealth: manifest.wreck.respawnHealth.status,
        respawnPosition: manifest.wreck.respawnPosition.status,
        impactImpulse: 'engine-input',
        source: 'recovered-data-and-source',
      },
    };
  }

  function hashState() {
    return fnv1a(canonical(snapshot()));
  }

  return {
    manifest,
    addCar,
    startRace,
    apply,
    advance,
    snapshot,
    hashState,
    drainEvents() {
      const copy = events.slice();
      events.length = 0;
      return copy;
    },
    get events() {
      return events.slice();
    },
    get tick() {
      return tick;
    },
    get lastCommandSeq() {
      return lastCommandSeq;
    },
    impact(targetId, optionsForImpact = {}) {
      const command = commandBase({ type: 'impact', targetId, ...optionsForImpact });
      dispatch(command);
      return command.seq;
    },
    weaponHit(targetId, optionsForHit = {}) {
      const command = commandBase({ type: 'weapon-hit', targetId, ...optionsForHit });
      dispatch(command);
      return command.seq;
    },
    repair(targetId, optionsForRepair = {}) {
      const command = commandBase({ type: 'repair', targetId, ...optionsForRepair });
      dispatch(command);
      return command.seq;
    },
    activateShield(targetId, optionsForShield = {}) {
      const command = commandBase({ type: 'activate-shield', targetId, ...optionsForShield });
      dispatch(command);
      return command.seq;
    },
    ram(targetId, optionsForRam = {}) {
      const command = commandBase({ type: 'ram', targetId, ...optionsForRam });
      dispatch(command);
      return command.seq;
    },
    applyEffect(targetId, optionsForEffect = {}) {
      const command = commandBase({ type: 'effect', targetId, ...optionsForEffect });
      dispatch(command);
      return command.seq;
    },
    setDamageMode(damageMode) {
      const command = commandBase({ type: 'set-damage-mode', damageMode });
      dispatch(command);
      return command.seq;
    },
  };
}
