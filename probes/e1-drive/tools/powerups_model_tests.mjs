// PWR2 event-model tests for the e1-drive power-up slice.
//
// Runs without a browser or GPU. It loads the real PWR1 manifest and the
// committed rules prototype, then drives the host `PowerupModel`:
//   mine arm/hit/near-miss/miss/expiry, shield absorb/break, repair,
//   damage -> wreck -> respawn, pickup proximity/capacity, provisional placement,
//   event sequencing and snapshot determinism.
//
// Usage:
//   node probes/e1-drive/tools/powerups_model_tests.mjs
//
// Writes `_work/e1-drive/powerups-node-report.json`; never a retail claim.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createWorld } from '../../powerups/rules/engine.js';
import { createProjectileModel } from '../../powerups/rules/projectiles.js';
import {
  POWERUP_DEFERRED, POWERUP_PLACEMENT_ARCS, POWERUP_PLACEMENT_TYPES, POWERUP_PROJECTILE_TYPES,
  POWERUP_PROVISIONAL_SHUNT_IMPULSE_NS, POWERUP_SLICE_TYPES, POWERUP_TARGET_RADIUS_M,
  createPowerupModel, provisionalPickupPlan
} from '../web/powerups.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const OUT = path.join(ROOT, '_work/e1-drive');
const MANIFEST = path.join(ROOT, '_work/powerups/powerups.json');
const PROJECTILES = path.join(ROOT, '_work/powerups/projectiles.json');
const LAYOUT = path.join(ROOT, '_work/e1-drive/sprint.json');

const checks = [];
function check(label, ok, detail = '') {
  checks.push({ label, ok: Boolean(ok), detail: String(detail) });
  if (!ok) console.error('FAIL ' + label + (detail ? ': ' + detail : ''));
}
const near = (a, b, epsilon = 1e-9) => Math.abs(a - b) <= epsilon;
const hasEvent = (events, type) => events.some((event) => event.type === type);
const eventOf = (events, type) => events.find((event) => event.type === type) ?? null;

function loadJson(file, label) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(label + ' missing or unreadable at ' + file + ': ' + error.message); }
}

const manifest = loadJson(MANIFEST, 'PWR1 manifest');
const projectileManifest = loadJson(PROJECTILES, 'PWR4 projectile manifest');
const layout = loadJson(LAYOUT, 'measured 310 m layout');

function makeModel() {
  return createPowerupModel({
    manifest,
    createWorld,
    projectileManifest,
    createProjectileModel,
    authorityId: 'host',
    maxHealth: 100,
    respawnDelaySeconds: 1.0,
    normalRespawnSeconds: null,
    inventoryCapacity: 1
  });
}

function addPair(model, options = {}) {
  model.addPlayer('p1', {
    position: options.p1 ?? { x: 20, y: 0, z: 0 },
    forward: options.p1Forward ?? { x: 0, y: 0, z: 1 },
    speedMps: options.p1Speed ?? 20,
    massKg: 1600
  });
  model.addPlayer('p2', {
    position: options.p2 ?? { x: 0, y: 0, z: 0 },
    forward: options.p2Forward ?? { x: 0, y: 0, z: 1 },
    speedMps: options.p2Speed ?? 20,
    massKg: 1600
  });
}

const respawnTarget = (playerId) => ({
  x: 0, y: 0, z: 0, headingRad: 0, gateId: 'test-gate', gateIndex: 0, playerId, source: 'test'
});

// ---------------------------------------------------------------- manifest/data
check('manifest exposes the 11 PickupType entities', manifest.entities.length === 11, manifest.entities.length);
check('manifest hash is present', typeof manifest.hashes?.manifestContent === 'string', manifest.hashes?.manifestContent);
check('integrated slice is exactly the eight core types',
  JSON.stringify(POWERUP_SLICE_TYPES) === JSON.stringify([
    'Bomb', 'Shield', 'Repair', 'Nitrous', 'Shock', 'Blindfire', 'Shunt', 'Barge'
  ]), POWERUP_SLICE_TYPES.join(','));
check('Blindfire, Shunt and Barge are the projectile types',
  JSON.stringify(POWERUP_PROJECTILE_TYPES) === JSON.stringify(['Blindfire', 'Shunt', 'Barge']),
  POWERUP_PROJECTILE_TYPES.join(','));
check('only SuperShield remains deferred, with a typed reason',
  typeof POWERUP_DEFERRED.SuperShield === 'string' && POWERUP_DEFERRED.SuperShield.length > 20 &&
  !('Shunt' in POWERUP_DEFERRED) && !('Blindfire' in POWERUP_DEFERRED) && !('Barge' in POWERUP_DEFERRED),
  JSON.stringify(Object.keys(POWERUP_DEFERRED)));

const catalog = makeModel().catalog;
const bomb = catalog.entities.get('Bomb').levels.Normal.values;
const shield = catalog.entities.get('Shield').levels.Normal.values;
const repair = catalog.entities.get('Repair').levels.Normal.values;
const nitrous = catalog.entities.get('Nitrous').levels.Normal;
const shock = catalog.entities.get('Shock').levels.Normal;
check('Bomb Radius traced to PWR1', near(bomb.Radius, 1.0), bomb.Radius);
check('Bomb OuterRadius traced to PWR1', near(bomb.OuterRadius, 3.5), bomb.OuterRadius);
check('Bomb DamageInflicted traced to PWR1', near(bomb.DamageInflicted, 100), bomb.DamageInflicted);
check('Bomb Lifespan traced to PWR1', near(bomb.Lifespan, 60), bomb.Lifespan);
check('Bomb MasterMinePrimeTimer traced to PWR1', near(bomb.MasterMinePrimeTimer, 0.3, 1e-6), bomb.MasterMinePrimeTimer);
check('Bomb PlaceBehindDistance traced to PWR1', near(bomb.PlaceBehindDistance, 5), bomb.PlaceBehindDistance);
check('Shield Health traced to PWR1', near(shield.Health, 50), shield.Health);
check('Shield Lifetime traced to PWR1', near(shield.Lifetime, 6), shield.Lifetime);
check('Repair AmountToRepair traced to PWR1', near(repair.AmountToRepair, 400), repair.AmountToRepair);
check('Nitrous Duration traced to PWR1', near(nitrous.values.Duration, 1.3, 1e-6), nitrous.values.Duration);
check('Nitrous class modifiers traced to PWR1',
  near(nitrous.values.ClassAModifier, 1, 1e-6) && near(nitrous.values.ClassBModifier, 0.95, 1e-6) &&
  near(nitrous.values.ClassCModifier, 0.9, 1e-6) && near(nitrous.values.ClassDModifier, 0.85, 1e-6),
  JSON.stringify({ A: nitrous.values.ClassAModifier, B: nitrous.values.ClassBModifier,
    C: nitrous.values.ClassCModifier, D: nitrous.values.ClassDModifier }));
check('Shock radii/lifetime/damage traced to PWR1',
  near(shock.values.InnerRadius, 7) && near(shock.values.OuterRadius, 14) &&
  near(shock.values.Lifetime, 1.5) && near(shock.values.DamageInflicted, 100),
  JSON.stringify({ inner: shock.values.InnerRadius, outer: shock.values.OuterRadius,
    lifetime: shock.values.Lifetime, damage: shock.values.DamageInflicted }));
check('Blindfire Speed/Radius/Damage traced to PWR4',
  near(projectileManifest.types.Blindfire.levels.Normal.fields.Speed.value, 300) &&
  near(projectileManifest.types.Blindfire.levels.Normal.fields.Radius.value, 0.2, 1e-6) &&
  near(projectileManifest.types.Blindfire.levels.Normal.fields.DamageInflicted.value, 50),
  JSON.stringify({ speed: projectileManifest.types.Blindfire.levels.Normal.fields.Speed.value,
    radius: projectileManifest.types.Blindfire.levels.Normal.fields.Radius.value,
    damage: projectileManifest.types.Blindfire.levels.Normal.fields.DamageInflicted.value }));
check('Blindfire lifetime/charges are typed runtime-only values',
  near(projectileManifest.runtimeValues.Blindfire.lifetimeSeconds, 10) &&
  projectileManifest.runtimeValues.Blindfire.charges === 3 &&
  projectileManifest.unknowns.Blindfire.some((row) => row.field === 'projectileLifetime' && row.status === 'runtime-only'),
  JSON.stringify(projectileManifest.runtimeValues.Blindfire));
check('Shunt Radius/Damage traced to PWR4',
  near(projectileManifest.types.Shunt.levels.Normal.fields.Radius.value, 0.75) &&
  near(projectileManifest.types.Shunt.levels.Normal.fields.DamageInflicted.value, 100),
  JSON.stringify({ radius: projectileManifest.types.Shunt.levels.Normal.fields.Radius.value,
    damage: projectileManifest.types.Shunt.levels.Normal.fields.DamageInflicted.value }));
check('Shunt lifetime/speed/homing are typed runtime-only values',
  near(projectileManifest.runtimeValues.Shunt.lifetimeSeconds, 40) &&
  projectileManifest.runtimeValues.Shunt.minSpeedMps === 60 &&
  projectileManifest.runtimeValues.Shunt.maxSpeedMps === 110 &&
  near(projectileManifest.runtimeValues.Shunt.maxHomingSpeedMps, 50) &&
  projectileManifest.runtimeValues.Shunt.charges === 1,
  JSON.stringify(projectileManifest.runtimeValues.Shunt));
check('Barge Radius/Damage/Duration traced to PWR4',
  near(projectileManifest.types.Barge.levels.Normal.fields.Radius.value, 7) &&
  near(projectileManifest.types.Barge.levels.Normal.fields.DamageInflicted.value, 100) &&
  near(projectileManifest.types.Barge.levels.Normal.fields.Duration.value, 0.4, 1e-6),
  JSON.stringify({ radius: projectileManifest.types.Barge.levels.Normal.fields.Radius.value,
    damage: projectileManifest.types.Barge.levels.Normal.fields.DamageInflicted.value,
    duration: projectileManifest.types.Barge.levels.Normal.fields.Duration.value }));
check('Barge padding/band/extents fudge are typed runtime-only values',
  near(projectileManifest.runtimeValues.Barge.paddingM, 0.5) &&
  near(projectileManifest.runtimeValues.Barge.innerBandM, 2.0) &&
  near(projectileManifest.runtimeValues.Barge.extentsFudgeAverageM, 1.75) &&
  projectileManifest.runtimeValues.Barge.charges === 1,
  JSON.stringify(projectileManifest.runtimeValues.Barge));
check('documented target envelope gives the committed OBB circumradius',
  near(POWERUP_TARGET_RADIUS_M, 1.7104677722775135, 1e-12) &&
  near(POWERUP_PROVISIONAL_SHUNT_IMPULSE_NS, 20000),
  String(POWERUP_TARGET_RADIUS_M));
check('PickupRadius traced to PWR1', near(catalog.system.radius, 2.0), catalog.system.radius);
check('PickupDeactivateTimer traced to PWR1', near(catalog.system.deactivateSeconds, 0.6, 1e-6), catalog.system.deactivateSeconds);

// ------------------------------------------------------------ provisional plan
const plan = provisionalPickupPlan(layout);
check('provisional plan has one pickup per configured arc', plan.length === POWERUP_PLACEMENT_ARCS.length, plan.length);
check('provisional plan types are the integrated slice only',
  plan.every((entry) => POWERUP_SLICE_TYPES.includes(entry.pickupType)),
  plan.map((entry) => entry.pickupType).join(','));
check('provisional plan is labelled provisional on every entry',
  plan.every((entry) => entry.placement === 'provisional-measured-arc' && /not retail/.test(entry.note)));
check('provisional plan uses measured samples (arc/position match)',
  plan.every((entry) => {
    const sample = layout.course.samples[entry.sampleIndex];
    return sample && near(sample.arc, entry.arc, 1e-9) && near(sample.x, entry.position.x, 1e-6) &&
      near(sample.z, entry.position.z, 1e-6);
  }));

// ------------------------------------------------------------------- collection
{
  const model = makeModel();
  addPair(model);
  const pickup = model.spawnPickup('Shield', { x: 19.0, y: 0, z: 0 }, { source: 'test' });
  let events = model.tick(1 / 60, {}, respawnTarget);
  check('pickup within PickupRadius is collected', hasEvent(events, 'pickup'), events.map((event) => event.type).join(','));
  check('collected item enters the one-slot inventory',
    model.players.get('p1').inventory.length === 1 &&
    model.players.get('p1').inventory[0].type === 'Shield',
    JSON.stringify(model.players.get('p1').inventory));
  check('collected pickup is deactivated', model.pickups.get(pickup.id).state === 'deactivated', model.pickups.get(pickup.id).state);
  const second = model.spawnPickup('Repair', { x: 20.0, y: 0, z: 0 }, { source: 'test' });
  events = model.tick(1 / 60, {}, respawnTarget);
  const rejected = eventOf(events, 'pickup-rejected');
  check('second pickup is rejected with inventory-full', rejected?.reason === 'inventory-full', rejected?.reason);
  check('rejected pickup stays active for the other car', model.pickups.get(second.id).state === 'active');
  check('inventory capacity is one active slot', model.players.get('p1').inventory.length === 1);
  check('pickup outside PickupRadius is not collected',
    !hasEvent(model.tick(1 / 60, { p1: { position: { x: 40, y: 0, z: 0 } } }, respawnTarget), 'pickup'));
}

// -------------------------------------------------------- mine arm/hit/respawn
{
  const model = makeModel();
  addPair(model, { p1: { x: 20, y: 0, z: 0 }, p2: { x: 0.5, y: 0, z: 0 } });
  model.grantItem('p1', 'Bomb');
  let events = model.requestUse('p1', { position: { x: 0, y: 0, z: 0 } });
  check('mine-placed is emitted', hasEvent(events, 'mine-placed'));
  const placed = eventOf(events, 'mine-placed');
  check('mine carries the recovered radius/outer/damage/lifespan',
    near(placed.mine.radius, 1.0) && near(placed.mine.outerRadius, 3.5) &&
    near(placed.mine.damage, 100) && near(placed.mine.expiresAt, 60, 0.01),
    JSON.stringify({ r: placed.mine.radius, o: placed.mine.outerRadius, d: placed.mine.damage, e: placed.mine.expiresAt }));
  events = model.tick(0.1, {}, respawnTarget);
  check('mine is not armed before MasterMinePrimeTimer', !hasEvent(events, 'mine-armed'));
  events = model.tick(0.25, {}, respawnTarget);
  check('mine-armed is emitted at the prime timer', hasEvent(events, 'mine-armed'));
  const detonated = eventOf(events, 'mine-detonated');
  check('mine detonates inside OuterRadius', Boolean(detonated), events.map((event) => event.type).join(','));
  check('direct hit is inside Radius', detonated?.directHits?.includes('p2') === true, JSON.stringify(detonated?.directHits));
  check('direct hit applies Bomb.DamageInflicted', model.players.get('p2').health === 0, model.players.get('p2').health);
  check('health zero emits wrecked', hasEvent(events, 'wrecked'));
  check('wreck schedules a diagnosed respawn delay', near(model.players.get('p2').respawnAt, model.now + 1.0, 1e-6),
    model.players.get('p2').respawnAt);
  events = model.tick(0.5, {}, respawnTarget);
  check('respawn waits for the diagnostic delay', !hasEvent(events, 'respawn'));
  events = model.tick(0.6, {}, respawnTarget);
  const respawn = eventOf(events, 'respawn');
  check('respawn is emitted after the delay', Boolean(respawn), events.map((event) => event.type).join(','));
  check('respawn uses the R1 respawn target', respawn?.target?.gateId === 'test-gate', JSON.stringify(respawn?.target));
  check('respawn restores the diagnostic health pool',
    model.players.get('p2').alive === true && model.players.get('p2').health === 100,
    JSON.stringify({ alive: model.players.get('p2').alive, health: model.players.get('p2').health }));
}

// ---------------------------------------------------------- mine near/miss/expiry
{
  const model = makeModel();
  addPair(model, { p1: { x: 20, y: 0, z: 0 }, p2: { x: 2.0, y: 0, z: 0 } });
  model.grantItem('p1', 'Bomb');
  model.requestUse('p1', { position: { x: 0, y: 0, z: 0 } });
  let events = model.tick(0.35, {}, respawnTarget);
  check('mine inside OuterRadius but outside Radius is a detonation', hasEvent(events, 'mine-detonated'));
  check('near miss emits typed mine-near-miss and no damage',
    hasEvent(events, 'mine-near-miss') && !hasEvent(events, 'damage') &&
    model.players.get('p2').health === 100,
    JSON.stringify({ health: model.players.get('p2').health }));

  const miss = makeModel();
  addPair(miss, { p1: { x: 20, y: 0, z: 0 }, p2: { x: 5.0, y: 0, z: 0 } });
  miss.grantItem('p1', 'Bomb');
  miss.requestUse('p1', { position: { x: 0, y: 0, z: 0 } });
  events = miss.tick(0.35, {}, respawnTarget);
  check('mine outside OuterRadius does not detonate', !hasEvent(events, 'mine-detonated') && !hasEvent(events, 'damage'));
  events = miss.tick(60.0, {}, respawnTarget);
  check('mine expires at the recovered Lifespan', hasEvent(events, 'mine-expired'),
    events.map((event) => event.type).join(','));
  check('expired mine is removed', miss.mines.length === 0, miss.mines.length);
}

// ---------------------------------------------------------- shield absorb/break
{
  const model = makeModel();
  addPair(model);
  model.grantItem('p1', 'Shield');
  let events = model.requestUse('p1');
  const activated = eventOf(events, 'shield-activated');
  check('shield-activated carries Shield health/lifetime',
    activated && near(activated.effect.capacity, 50) && near(activated.effect.expiresAt, 6, 1e-6),
    JSON.stringify(activated?.effect));
  const first = model.world.damage('p1', 25, { kind: 'test' });
  check('shield absorbs the first hit', near(first.absorbed, 25) && first.health === 100,
    JSON.stringify(first));
  check('shield-absorbed is emitted', hasEvent(first.events, 'shield-absorbed'));
  const second = model.world.damage('p1', 50, { kind: 'test' });
  check('shield absorbs its remaining capacity', near(second.absorbed, 25), JSON.stringify(second));
  check('shield breaks and the overflow damages health',
    hasEvent(second.events, 'shield-broken') && near(second.remaining, 25) && second.health === 75,
    JSON.stringify(second));
  check('shield effect is removed after the break', model.effects.length === 0, model.effects.length);
}

// ------------------------------------------------------------------- repair
{
  const model = makeModel();
  addPair(model);
  model.world.damage('p1', 60, { kind: 'test' });
  check('test damage reduced health to 40', model.players.get('p1').health === 40, model.players.get('p1').health);
  model.grantItem('p1', 'Repair');
  const events = model.requestUse('p1');
  const repaired = eventOf(events, 'repaired');
  check('Repair is capped at the diagnostic max health',
    repaired && repaired.health === 100 && near(repaired.amount, 60),
    JSON.stringify(repaired));
  check('repaired event is emitted', hasEvent(events, 'repaired'));
}

// ------------------------------------------------------------------- nitro
{
  const model = makeModel();
  addPair(model);
  model.grantItem('p1', 'Nitrous');
  const events = model.requestUse('p1', { tick: 120, speedMps: 24.73, speedSource: 'test' });
  const nitro = eventOf(events, 'nitro-activated');
  check('nitro-activated is host-sequenced with the exact class-A target',
    nitro && nitro.targetPlayer === 'p1' && near(nitro.targetMps, 52.758963, 1e-6) &&
    near(nitro.speedMps, 24.73, 1e-6) && nitro.classLetter === 'A' &&
    near(nitro.classModifier, 1, 1e-6) && nitro.ticks === 78 && near(nitro.magnitude, 300) &&
    nitro.source === 'recovered' && nitro.targetSource === 'pwr1-hermite',
    JSON.stringify(nitro && { targetMps: nitro.targetMps, speedMps: nitro.speedMps,
      classLetter: nitro.classLetter, ticks: nitro.ticks, magnitude: nitro.magnitude }));
  check('nitro-activated carries the full class target table',
    near(nitro?.targetTable?.A?.targetMps, 52.758963, 1e-6) &&
    near(nitro?.targetTable?.B?.targetMps, 50.121015, 1e-6) &&
    near(nitro?.targetTable?.C?.targetMps, 47.483066, 1e-6) &&
    near(nitro?.targetTable?.D?.targetMps, 44.845120, 1e-6),
    JSON.stringify(nitro?.targetTable && Object.fromEntries(Object.entries(nitro.targetTable).map(([k, v]) => [k, v.targetMps]))));
  check('nitro effect carries the force window and expiry',
    model.effects.length === 1 && near(model.effects[0].expiresAt, 1.3, 1e-6) &&
    model.effects[0].ticks === 78 && model.effects[0].forceWindowTicks === 30,
    JSON.stringify(model.effects[0]));
  const expired = model.tick(1.31, {}, respawnTarget);
  check('nitro effect expires at the recovered Duration', hasEvent(expired, 'effect-expired'),
    expired.map((event) => event.type).join(','));
}

// ------------------------------------------------------------------- shock
{
  const model = makeModel();
  addPair(model, { p1: { x: 0, y: 0, z: 0 }, p2: { x: 3, y: 0, z: 0 } });
  model.grantItem('p1', 'Shock');
  const events = model.requestUse('p1', {
    position: { x: 3, y: 0, z: 0 }, tick: 60, speedMps: 24.73,
    speeds: { p1: 24.73, p2: 24.73 }, speedSource: 'test'
  });
  const shock = eventOf(events, 'shock-activated');
  const target = (shock?.targets ?? []).find((row) => row.targetPlayer === 'p2') ?? null;
  check('shock-activated carries the recovered radii/lifetime/damage',
    shock && shock.innerRadius === 7 && shock.outerRadius === 14 &&
    shock.lifetime === 1.5 && shock.damage === 100 &&
    shock.source === 'recovered' && shock.targetSource === 'pwr1-hermite',
    JSON.stringify(shock && { inner: shock.innerRadius, outer: shock.outerRadius,
      lifetime: shock.lifetime, damage: shock.damage }));
  check('Shock target uses the exact curve and the 10 mph floor',
    target && near(target.targetMps, 19.995236, 1e-6) &&
    near(target.graphValue, 0.223640, 1e-6) && target.hit === 'inner',
    JSON.stringify(target));
  check('Shock applies DamageInflicted through the host health model',
    hasEvent(events, 'damage') && hasEvent(events, 'wrecked') &&
    model.players.get('p2').health === 0,
    JSON.stringify({ health: model.players.get('p2').health, events: events.map((event) => event.type) }));
  const expired = model.tick(1.51, {}, respawnTarget);
  check('Shock effect expires at the recovered Lifetime',
    hasEvent(expired, 'effect-expired'),
    expired.map((event) => event.type).join(','));

  const miss = makeModel();
  addPair(miss, { p1: { x: 0, y: 0, z: 0 }, p2: { x: 30, y: 0, z: 0 } });
  miss.grantItem('p1', 'Shock');
  const missEvents = miss.requestUse('p1', {
    position: { x: 0, y: 0, z: 0 }, tick: 0, speedMps: 24.73,
    speeds: { p1: 24.73, p2: 24.73 }
  });
  check('Shock outside OuterRadius has no target and no damage',
    (eventOf(missEvents, 'shock-activated')?.targets ?? []).length === 0 &&
    !hasEvent(missEvents, 'damage'),
    JSON.stringify(eventOf(missEvents, 'shock-activated')?.targets));
}


{
  const model = makeModel();
  addPair(model);
  const result = model.world.damage('p2', 100, { kind: 'direct' });
  check('direct 100 damage wrecks the diagnostic 100 HP pool',
    hasEvent(result.events, 'wrecked') && model.players.get('p2').alive === false,
    JSON.stringify({ health: result.health, alive: model.players.get('p2').alive }));
  let events = model.tick(1.05, {}, respawnTarget);
  check('wreck -> respawn waits one diagnostic delay', !hasEvent(events, 'respawn'));
  events = model.tick(1.05, {}, respawnTarget);
  check('wreck -> respawn emits the respawn event', hasEvent(events, 'respawn'));
  check('respawn target is traceable to the supplied rules target',
    eventOf(events, 'respawn')?.source === 'race-rules-respawn-target');
}

// ------------------------------------------------- projectile weapons
{
  const model = makeModel();
  addPair(model, { p1: { x: 0, y: 0, z: 0 }, p2: { x: 0, y: 0, z: 30 } });
  model.grantItem('p1', 'Blindfire');
  const item = model.players.get('p1').inventory[0];
  check('Blindfire pickup grants the runtime 3 charges',
    item?.type === 'Blindfire' && model.projectileCharges('p1', 'Blindfire') === 3,
    JSON.stringify({ item, charges: model.projectileCharges('p1', 'Blindfire') }));
  let events = model.requestUse('p1');
  const fired = eventOf(events, 'projectile-fired');
  check('Blindfire fires the recovered 300 m/s / 0.2 m / 50 damage bolt',
    fired && near(fired.speedMps, 300) && fired.pickupType === 'Blindfire' &&
    near(fired.chargesRemaining, 2) && near(fired.lifetimeSeconds, 10) &&
    fired.lifetimeSource === 'runtime-only',
    JSON.stringify(fired && { speed: fired.speedMps, charges: fired.chargesRemaining,
      lifetime: fired.lifetimeSeconds, source: fired.lifetimeSource }));
  let hit = null;
  for (let tick = 0; tick < 30 && !hit; tick++) {
    events = model.tick(1 / 60, {}, respawnTarget);
    hit = eventOf(events, 'projectile-hit');
  }
  check('Blindfire swept sphere hits the documented target envelope', Boolean(hit),
    events.map((event) => event.type).join(','));
  check('Blindfire applies 50 damage through the 100 HP model',
    hit && near(hit.damage, 50) && model.players.get('p2').health === 50,
    JSON.stringify({ hit: hit?.damage, health: model.players.get('p2').health }));
  check('a Blindfire hit leaves 2 of 3 charges in the inventory slot',
    model.players.get('p1').inventory.length === 1 &&
    model.projectileCharges('p1', 'Blindfire') === 2,
    JSON.stringify(model.players.get('p1').inventory));
}

{
  const model = makeModel();
  addPair(model, { p1: { x: 0, y: 0, z: 0 }, p2: { x: 50, y: 0, z: 0 } });
  model.grantItem('p1', 'Blindfire');
  model.requestUse('p1');
  let events = [];
  for (let tick = 0; tick < 12; tick++) {
    events = model.tick(1.0, {}, respawnTarget);
    if (hasEvent(events, 'projectile-expired')) break;
  }
  const expired = eventOf(events, 'projectile-expired');
  check('Blindfire miss expires at the runtime-only 10 s lifetime',
    expired && expired.reason === 'old-age' && near(expired.lifetimeSeconds, 10),
    JSON.stringify(expired));
  check('an expired Blindfire did no damage and left no projectile',
    model.players.get('p2').health === 100 && model.projectiles.projectiles.length === 0,
    JSON.stringify({ health: model.players.get('p2').health,
      projectiles: model.projectiles.projectiles.length }));
}

{
  const model = makeModel();
  addPair(model, { p1: { x: 0, y: 0, z: 0 }, p2: { x: 0, y: 0, z: 40 } });
  model.grantItem('p1', 'Blindfire');
  const charges = [];
  for (let shot = 0; shot < 3; shot++) {
    const events = model.requestUse('p1');
    charges.push(eventOf(events, 'projectile-fired')?.chargesRemaining ?? null);
    model.tick(0.11, {}, respawnTarget);
  }
  check('Blindfire consumes exactly 3 charges then removes the item',
    JSON.stringify(charges) === JSON.stringify([2, 1, 0]) &&
    model.players.get('p1').inventory.length === 0,
    JSON.stringify({ charges, inventory: model.players.get('p1').inventory }));
  const rejected = model.requestUse('p1');
  check('a fourth Blindfire use is a typed empty-inventory rejection',
    eventOf(rejected, 'use-rejected')?.reason === 'empty-inventory',
    JSON.stringify(eventOf(rejected, 'use-rejected')));
}

{
  const model = makeModel();
  addPair(model, { p1: { x: 0, y: 0, z: 0 }, p2: { x: 0, y: 0, z: 30 } });
  model.grantItem('p1', 'Shunt');
  let events = model.requestUse('p1');
  const fired = eventOf(events, 'projectile-fired');
  check('Shunt fires at the runtime initial max(forward+15,10) clamped 60..110',
    fired && fired.targetId === 'p2' && near(fired.speedMps, 60) &&
    fired.homing?.maxHomingSpeedMps === 50 && fired.homing?.minSpeedMps === 60,
    JSON.stringify(fired && { speed: fired.speedMps, homing: fired.homing }));
  let hit = null;
  let shuntHit = null;
  for (let tick = 0; tick < 80 && !shuntHit; tick++) {
    events = model.tick(1 / 60, {}, respawnTarget);
    hit = hit || eventOf(events, 'projectile-hit');
    shuntHit = eventOf(events, 'shunt-hit');
  }
  check('Shunt homes to the 500 m / cos 45 target and damages 100 (major)',
    hit && shuntHit && hit.hitType === 'major' && near(hit.damage, 100) &&
    shuntHit.fakePhysics?.kind === 'flip-forward',
    JSON.stringify({ hit, shuntHit }));
  check('Shunt wrecked the 100 HP target',
    model.players.get('p2').health === 0 && model.players.get('p2').alive === false,
    JSON.stringify({ health: model.players.get('p2').health, alive: model.players.get('p2').alive }));
  const impulse = shuntHit?.impulse ?? null;
  check('Shunt hit carries the provisional impulse with delta-v = J/m',
    impulse && impulse.source === 'provisional-impulse' &&
    impulse.status === 'provisional-impulse' &&
    near(impulse.impulseNs, 20000) && near(impulse.massKg, 1600) &&
    near(impulse.deltaV, 12.5) && impulse.direction != null,
    JSON.stringify(impulse));
  check('Shunt is a one-charge item and leaves the inventory empty',
    model.players.get('p1').inventory.length === 0 &&
    model.projectileCharges('p1', 'Shunt') === 0);
}

{
  const model = makeModel();
  addPair(model, { p1: { x: 0, y: 0, z: 0 }, p2: { x: 0, y: 0, z: -30 } });
  model.grantItem('p1', 'Shunt');
  const events = model.requestUse('p1');
  const rejected = eventOf(events, 'projectile-rejected');
  check('Shunt refuses a target outside the 500 m / cos 45 forward cone',
    rejected?.reason === 'no-eligible-target' && model.players.get('p1').inventory.length === 1,
    JSON.stringify(rejected));
}

{
  const major = makeModel();
  addPair(major, { p1: { x: 0, y: 0, z: 0 }, p2: { x: 5, y: 0, z: 0 } });
  major.grantItem('p1', 'Barge');
  let events = major.requestUse('p1');
  const activated = eventOf(events, 'barge-activated');
  check('Barge activates the recovered radius/duration with the +0.5 runtime padding',
    activated && near(activated.radius, 7) && near(activated.durationSeconds, 0.4, 1e-6) &&
    near(activated.hitTest.majorRadius, 7.5) && near(activated.hitTest.innerBand, 2),
    JSON.stringify(activated && { radius: activated.radius, duration: activated.durationSeconds,
      hitTest: activated.hitTest }));
  events = major.tick(1 / 60, {}, respawnTarget);
  const bargeHit = eventOf(events, 'barge-hit');
  check('Barge major band hits for 100 inside 7.5 + envelope fudge - 2.0 m',
    bargeHit && bargeHit.hitType === 'major' && near(bargeHit.damage, 100) &&
    near(bargeHit.outerRadius, 8.08, 1e-6) && near(bargeHit.innerRadius, 6.08, 1e-6),
    JSON.stringify(bargeHit));
  check('Barge damage wrecks the 100 HP target', major.players.get('p2').health === 0);
  check('Barge fake-physics is the labelled JINK with no serialized magnitude',
    bargeHit?.fakePhysics?.kind === 'jink-barge-right' &&
    bargeHit?.fakePhysics?.magnitude?.status === 'not-serialized',
    JSON.stringify(bargeHit?.fakePhysics));
  const snapshot = major.snapshot();
  check('Barge snapshot exposes the 8.08 m outer and 6.08 m inner band',
    snapshot.barges.length === 1 && near(snapshot.barges[0].outerRadius, 8.08, 1e-6) &&
    near(snapshot.barges[0].innerRadius, 6.08, 1e-6),
    JSON.stringify(snapshot.barges));

  const minor = makeModel();
  addPair(minor, { p1: { x: 0, y: 0, z: 0 }, p2: { x: 7, y: 0, z: 0 } });
  minor.grantItem('p1', 'Barge');
  minor.requestUse('p1');
  const minorEvents = minor.tick(1 / 60, {}, respawnTarget);
  const minorHit = eventOf(minorEvents, 'barge-hit');
  check('Barge minor band (7 m) still applies 100 and only changes the jink',
    minorHit?.hitType === 'minor' && near(minorHit.damage, 100) &&
    minorHit?.fakePhysics?.kind === 'jink-barge-minor-right',
    JSON.stringify(minorHit));

  const miss = makeModel();
  addPair(miss, { p1: { x: 0, y: 0, z: 0 }, p2: { x: 10, y: 0, z: 0 } });
  miss.grantItem('p1', 'Barge');
  miss.requestUse('p1');
  const missEvents = miss.tick(0.5, {}, respawnTarget);
  check('Barge outside the 8.08 m outer band misses and expires at 0.4 s',
    !hasEvent(missEvents, 'barge-hit') && hasEvent(missEvents, 'effect-expired') &&
    miss.snapshot().barges.length === 0,
    missEvents.map((event) => event.type).join(','));
}

{
  const model = makeModel();
  addPair(model, { p1: { x: 0, y: 0, z: 0 }, p2: { x: 0, y: 0, z: 30 } });
  model.grantItem('p2', 'Shield');
  model.requestUse('p2');
  model.grantItem('p1', 'Blindfire');
  model.requestUse('p1');
  let events = [];
  for (let tick = 0; tick < 30; tick++) {
    events = model.tick(1 / 60, {}, respawnTarget);
    if (hasEvent(events, 'projectile-hit')) break;
  }
  check('projectile damage passes through the PWR1 shield absorb model',
    hasEvent(events, 'shield-absorbed') && model.players.get('p2').health === 100 &&
    eventOf(events, 'projectile-hit')?.absorbed === 50,
    JSON.stringify({ events: events.map((event) => event.type), health: model.players.get('p2').health }));
}

{
  const run = () => {
    const model = makeModel();
    addPair(model, { p1: { x: 0, y: 0, z: 0 }, p2: { x: 0, y: 0, z: 30 } });
    model.grantItem('p1', 'Blindfire');
    model.requestUse('p1');
    for (let tick = 0; tick < 60; tick++) model.tick(1 / 60, {}, respawnTarget);
    model.grantItem('p1', 'Shunt');
    model.requestUse('p1');
    for (let tick = 0; tick < 60; tick++) model.tick(1 / 60, {}, respawnTarget);
    model.grantItem('p1', 'Barge');
    model.requestUse('p1');
    for (let tick = 0; tick < 30; tick++) model.tick(1 / 60, {}, respawnTarget);
    return JSON.stringify(model.snapshot());
  };
  const a = run();
  const b = run();
  check('the same projectile command sequence yields the same snapshot',
    a === b, 'sha256:' + createHash('sha256').update(a).digest('hex'));
}

// -------------------------------------------------------------- sequencing
{
  const model = makeModel();
  addPair(model);
  model.spawnProvisionalPickups(layout);
  model.grantItem('p1', 'Bomb');
  model.requestUse('p1', { position: { x: 0, y: 0, z: 0 } });
  const events = model.events;
  check('every event carries a monotonic seq', events.every((event, index) => event.seq === index + 1));
  check('every event carries the host authority label', events.every((event) => event.authority === 'host'));
  const snapshot = model.snapshot();
  check('snapshot sorts players and pickups deterministically',
    JSON.stringify(snapshot.players.map((row) => row.id)) === JSON.stringify([...snapshot.players.map((row) => row.id)].sort()) &&
    JSON.stringify(snapshot.pickups.map((row) => row.id)) === JSON.stringify([...snapshot.pickups.map((row) => row.id)].sort()));
  check('snapshot states the provisional placement and diagnostic labels',
    snapshot.provisionalPlacement === 'provisional-measured-arc' &&
    /runtime-only/.test(snapshot.labels.healthScale) &&
    /not serialized/.test(snapshot.labels.respawnDelay),
    JSON.stringify(snapshot.labels));
  check('snapshot exposes the deferred list', Object.keys(snapshot.labels).length >= 8);
}

// ------------------------------------------------------------- deterministic replay
{
  const run = () => {
    const model = makeModel();
    addPair(model, { p1: { x: 20, y: 0, z: 0 }, p2: { x: 0.5, y: 0, z: 0 } });
    model.spawnProvisionalPickups(layout);
    model.grantItem('p1', 'Bomb');
    model.requestUse('p1', { position: { x: 0, y: 0, z: 0 } });
    for (let tick = 0; tick < 180; tick++) model.tick(1 / 60, {}, respawnTarget);
    return JSON.stringify(model.snapshot());
  };
  const a = run();
  const b = run();
  check('same command sequence yields the same snapshot', a === b,
    'sha256:' + createHash('sha256').update(a).digest('hex'));
}

// --------------------------------------------------------------------------- report
const passed = checks.filter((entry) => entry.ok).length;
const report = {
  kind: 'e1-drive.powerups-node',
  version: 1,
  generatedBy: 'probes/e1-drive/tools/powerups_model_tests.mjs',
  inputs: {
    manifest: path.relative(ROOT, MANIFEST).replaceAll('\\', '/'),
    manifestContentHash: manifest.hashes?.manifestContent ?? null,
    projectileManifest: path.relative(ROOT, PROJECTILES).replaceAll('\\', '/'),
    projectileManifestContentHash: projectileManifest.hashes?.manifestContent ?? null,
    layout: path.relative(ROOT, LAYOUT).replaceAll('\\', '/'),
    layoutHash: layout.hash ?? null
  },
  slice: {
    types: POWERUP_SLICE_TYPES.slice(),
    deferred: { ...POWERUP_DEFERRED },
    projectileTypes: POWERUP_PROJECTILE_TYPES.slice(),
    placementArcs: POWERUP_PLACEMENT_ARCS.slice(),
    placementTypes: POWERUP_PLACEMENT_TYPES.slice(),
    normalRespawnSeconds: null,
    healthModel: 'diagnostic 100 HP; healthScale is runtime-only in PWR1',
    respawnDelaySeconds: 1.0
  },
  checks: {
    total: checks.length,
    passed,
    failed: checks.length - passed,
    failures: checks.filter((entry) => !entry.ok)
  },
  results: checks
};
mkdirSync(OUT, { recursive: true });
writeFileSync(path.join(OUT, 'powerups-node-report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log('power-up model tests: ' + passed + '/' + checks.length + ' passed');
if (report.checks.failed) {
  console.error(report.checks.failures.map((entry) => entry.label).join('\n'));
  process.exit(1);
}
