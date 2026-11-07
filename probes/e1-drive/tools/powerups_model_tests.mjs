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
import {
  POWERUP_DEFERRED, POWERUP_PLACEMENT_ARCS, POWERUP_PLACEMENT_TYPES, POWERUP_SLICE_TYPES,
  createPowerupModel, provisionalPickupPlan
} from '../web/powerups.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const OUT = path.join(ROOT, '_work/e1-drive');
const MANIFEST = path.join(ROOT, '_work/powerups/powerups.json');
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
const layout = loadJson(LAYOUT, 'measured 310 m layout');

function makeModel() {
  return createPowerupModel({
    manifest,
    createWorld,
    authorityId: 'host',
    maxHealth: 100,
    respawnDelaySeconds: 1.0,
    normalRespawnSeconds: null,
    inventoryCapacity: 1
  });
}

function addPair(model, options = {}) {
  model.addPlayer('p1', { position: options.p1 ?? { x: 20, y: 0, z: 0 }, forward: { x: 0, y: 0, z: 1 } });
  model.addPlayer('p2', { position: options.p2 ?? { x: 0, y: 0, z: 0 }, forward: { x: 0, y: 0, z: 1 } });
}

const respawnTarget = (playerId) => ({
  x: 0, y: 0, z: 0, headingRad: 0, gateId: 'test-gate', gateIndex: 0, playerId, source: 'test'
});

// ---------------------------------------------------------------- manifest/data
check('manifest exposes the 11 PickupType entities', manifest.entities.length === 11, manifest.entities.length);
check('manifest hash is present', typeof manifest.hashes?.manifestContent === 'string', manifest.hashes?.manifestContent);
check('integrated slice is exactly Bomb/Shield/Repair/Nitrous/Shock',
  JSON.stringify(POWERUP_SLICE_TYPES) === JSON.stringify(['Bomb', 'Shield', 'Repair', 'Nitrous', 'Shock']), POWERUP_SLICE_TYPES.join(','));
for (const type of ['Shunt', 'Blindfire', 'Barge', 'SuperShield']) {
  check('deferred type ' + type + ' has a typed reason', typeof POWERUP_DEFERRED[type] === 'string' && POWERUP_DEFERRED[type].length > 20);
}
check('Nitro and Shock are no longer deferred',
  !('Nitrous' in POWERUP_DEFERRED) && !('Shock' in POWERUP_DEFERRED),
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
    layout: path.relative(ROOT, LAYOUT).replaceAll('\\', '/'),
    layoutHash: layout.hash ?? null
  },
  slice: {
    types: POWERUP_SLICE_TYPES.slice(),
    deferred: { ...POWERUP_DEFERRED },
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
