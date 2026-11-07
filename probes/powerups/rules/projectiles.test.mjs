/**
 * Unit tests for the PWR4 typed projectile / impulse model.
 *
 * Run:
 *   node probes/powerups/rules/projectiles.test.mjs
 *   node probes/powerups/rules/projectiles.test.mjs --manifest _work/powerups/projectiles.json
 *
 * The tests read the recovered manifest; they do not contain game values of
 * their own. If the manifest is missing, the run fails with the command that
 * produces it.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createProjectileModel, recoveredValues } from './projectiles.js';

const args = process.argv.slice(2);
const manifestArg = args.includes('--manifest')
  ? args[args.indexOf('--manifest') + 1]
  : resolve(process.cwd(), '_work/powerups/projectiles.json');

if (!existsSync(manifestArg)) {
  console.error(`manifest not found: ${manifestArg}`);
  console.error('run: python probes/powerups/tools/build_projectiles.py');
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(manifestArg, 'utf8'));
const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error: error.message });
    console.error(`FAIL ${name}: ${error.message}`);
  }
}

function makeWorld() {
  return createProjectileModel(manifest, { authorityId: 'host-A' });
}

function collect(world, fn) {
  const start = world.events.length;
  fn();
  return world.events.slice(start);
}

function advanceUntil(world, predicate, step = 0.05, max = 2000) {
  for (let i = 0; i < max; i += 1) {
    const events = world.advance(step);
    if (predicate(events, world)) return events;
  }
  throw new Error('advanceUntil: predicate never true');
}

function blindfireSetup({ targetX = 0, targetZ = 30, targetRadius = 1.0, charges = 3 } = {}) {
  const world = makeWorld();
  world.addCar('p1', { position: { x: 0, y: 0, z: 0 }, forward: { x: 0, y: 0, z: 1 }, radiusM: 1.0 });
  world.addCar('p2', { position: { x: targetX, y: 0, z: targetZ }, radiusM: targetRadius });
  world.addInventory('p1', 'Blindfire', charges);
  return world;
}

function shuntSetup({ targetZ = 30, health = null } = {}) {
  const world = makeWorld();
  world.addCar('p1', { position: { x: 0, y: 0, z: 0 }, forward: { x: 0, y: 0, z: 1 }, radiusM: 1.0, speedMps: 0 });
  world.addCar('p2', { position: { x: 0, y: 0, z: targetZ }, radiusM: 1.0, speedMps: 0 });
  world.addInventory('p1', 'Shunt', 1);
  const projectile = world.fireShunt({ ownerId: 'p1', targetId: 'p2' });
  if (health != null) projectile.health = health;
  return { world, projectile };
}

function bargeSetup(targetX) {
  const world = makeWorld();
  world.addCar('p1', { position: { x: 0, y: 0, z: 0 }, radiusM: 1.0 });
  world.addCar('p2', { position: { x: targetX, y: 0, z: 0 }, radiusM: 1.0, extents: { x: 3.5, z: 3.5 } });
  world.addInventory('p1', 'Barge', 1);
  world.fireBarge({ ownerId: 'p1' });
  return world;
}

function shockSetup({ targetZ, width = 0.5, sizeMultiplier = 1.0, lifetimeModSeconds = 0, targetY = 0 }) {
  const world = makeWorld();
  world.addCar('p1', { position: { x: 0, y: 0, z: -50 }, radiusM: 1.0 });
  world.addCar('p2', { position: { x: 0, y: targetY, z: targetZ }, radiusM: 1.0 });
  world.addInventory('p1', 'Shock', 1);
  world.fireShock({
    ownerId: 'p1',
    targetId: 'p2',
    domes: [{ position: { x: 0, y: 0, z: 0 }, width, sizeMultiplier, lifetimeModSeconds }],
  });
  return world;
}

// ---------------------------------------------------------------------------
test('manifest exposes recovered projectile values and typed runtime fields', () => {
  assert.equal(manifest.schema, 'blur-powerups-projectiles/1');
  assert.equal(manifest.existingManifest.intact, true);
  assert.equal(manifest.existingManifest.verifierChecks, 1783);
  const blindfire = recoveredValues(manifest, 'Blindfire');
  assert.equal(blindfire.Speed, 300);
  assert.ok(Math.abs(blindfire.Radius - 0.2) < 1e-6);
  assert.equal(blindfire.DamageInflicted, 50);
  assert.equal(manifest.runtimeValues.Blindfire.lifetimeSeconds, 10);
  assert.equal(manifest.runtimeValues.Blindfire.charges, 3);
  assert.equal(manifest.unknowns.Blindfire.find((x) => x.field === 'projectileLifetime').status, 'runtime-only');
});

test('PerkForceEffects dynamic-object forces are recovered', () => {
  const effects = manifest.perkForceEffects.effects;
  assert.equal(effects.Shock.fields.MaxForce.value, 5);
  assert.equal(effects.ShuntFire.fields.MaxForce.value, 10);
  assert.equal(effects.ShuntExplode.fields.MaxForce.value, 100);
  assert.equal(effects.Barge.fields.MaxForce.value, 8);
  assert.equal(effects.Blindfire.fields.MaxForce.value, 10);
  assert.equal(manifest.perkForceEffects.crossReference.resolvesByRefIdInPickups, true);
});

test('Blindfire projectile: speed, radius, damage and lifetime come from the manifest', () => {
  const world = blindfireSetup();
  const p = world.fireBlindfire({ ownerId: 'p1', direction: { x: 0, y: 0, z: 1 } });
  assert.equal(p.speedMps, 300);
  assert.ok(Math.abs(p.radiusM - 0.2) < 1e-6);
  assert.equal(p.damage, 50);
  assert.equal(p.lifetimeSeconds, 10);
  assert.equal(p.chargesRemaining, 2);
  const fired = world.events.find((e) => e.type === 'projectile-fired');
  assert.equal(fired.lifetimeSource, 'runtime-only');
  assert.equal(fired.chargesRemaining, 2);
});

test('Blindfire travel and hit: a target 30 m ahead takes 50 damage', () => {
  const world = blindfireSetup();
  world.fireBlindfire({ ownerId: 'p1', direction: { x: 0, y: 0, z: 1 } });
  const events = world.advance(0.1);
  const hit = events.find((e) => e.type === 'projectile-hit');
  assert.ok(hit, 'projectile-hit event');
  assert.equal(hit.targetId, 'p2');
  assert.equal(hit.hitType, 'major');
  assert.equal(hit.damage, 50);
  assert.equal(world.cars.get('p2').health, 50);
});

test('Blindfire miss: an offset target is not hit and the projectile expires at 10 s', () => {
  const world = blindfireSetup({ targetX: 5 });
  world.fireBlindfire({ ownerId: 'p1', direction: { x: 0, y: 0, z: 1 } });
  let events = world.advance(0.1);
  assert.ok(!events.some((e) => e.type === 'projectile-hit'));
  assert.equal(world.cars.get('p2').health, 100);
  events = world.advance(9.95);
  const expired = events.find((e) => e.type === 'projectile-expired');
  assert.ok(expired, 'projectile-expired event');
  assert.equal(expired.reason, 'old-age');
  assert.equal(expired.lifetimeSeconds, 10);
});

test('Blindfire charges: three shots are consumed and the fourth is rejected', () => {
  const world = blindfireSetup({ targetZ: 300 });
  const first = world.fireBlindfire({ ownerId: 'p1', direction: { x: 0, y: 0, z: 1 } });
  const second = world.fireBlindfire({ ownerId: 'p1', direction: { x: 0, y: 0, z: 1 } });
  const third = world.fireBlindfire({ ownerId: 'p1', direction: { x: 0, y: 0, z: 1 } });
  assert.deepEqual([first.chargesRemaining, second.chargesRemaining, third.chargesRemaining], [2, 1, 0]);
  const rejected = world.fireBlindfire({ ownerId: 'p1', direction: { x: 0, y: 0, z: 1 } });
  assert.equal(rejected.type, 'projectile-rejected');
  assert.equal(rejected.reason, 'no-ammo');
});

test('Shunt major hit: full-health projectile does 100 and emits flip-forward', () => {
  const { world } = shuntSetup();
  const events = advanceUntil(world, (row) => row.some((e) => e.type === 'projectile-hit'), 0.05, 200);
  const hit = events.find((e) => e.type === 'projectile-hit');
  assert.equal(hit.hitType, 'major');
  assert.equal(hit.damage, 100);
  assert.equal(hit.fakePhysics.kind, 'flip-forward');
  const flip = world.events.find((e) => e.type === 'shunt-hit');
  assert.equal(flip.impulse.status, 'not-serialized');
  assert.equal(world.cars.get('p2').health, 0);
});

test('Shunt minor hit: a damaged projectile does 50 and emits tip-forward', () => {
  const { world } = shuntSetup({ health: 50 });
  const events = advanceUntil(world, (row) => row.some((e) => e.type === 'projectile-hit'), 0.05, 200);
  const hit = events.find((e) => e.type === 'projectile-hit');
  assert.equal(hit.hitType, 'minor');
  assert.equal(hit.damage, 50);
  assert.equal(hit.fakePhysics.kind, 'tip-forward');
});

test('Shunt provisional impulse: J/mass is explicit and labelled provisional', () => {
  const world = makeWorld();
  const ev = world.applyProvisionalShuntImpulse('p2', { impulseNs: 20000, massKg: 1600 });
  assert.equal(ev.type, 'shunt-impulse-provisional');
  assert.equal(ev.deltaV, 12.5);
  assert.equal(ev.source, 'provisional-impulse');
  const refused = world.applyProvisionalShuntImpulse('p2', {});
  assert.equal(refused.type, 'impulse-refused');
  assert.equal(refused.missing.status, 'not-serialized');
});

test('Barge major hit: 5 m from the owner is inside the inner band', () => {
  const world = bargeSetup(5);
  const events = world.advance(0.01);
  const hit = events.find((e) => e.type === 'barge-hit');
  assert.ok(hit);
  assert.equal(hit.hitType, 'major');
  assert.equal(hit.damage, 100);
  assert.equal(hit.fakePhysics.kind, 'jink-barge-right');
  assert.equal(world.cars.get('p2').health, 0);
});

test('Barge minor hit: 8 m is outside the inner band but inside the circle', () => {
  const world = bargeSetup(8);
  const events = world.advance(0.01);
  const hit = events.find((e) => e.type === 'barge-hit');
  assert.ok(hit);
  assert.equal(hit.hitType, 'minor');
  assert.equal(hit.damage, 100); // Barge minor is not halved (unlike Shunt/Shock)
  assert.equal(hit.fakePhysics.kind, 'jink-barge-minor-right');
});

test('Barge miss and expire: 10 m is outside the circle; the effect ends at 0.4 s', () => {
  const world = bargeSetup(10);
  let events = world.advance(0.01);
  assert.ok(!events.some((e) => e.type === 'barge-hit'));
  events = world.advance(0.4);
  const expired = events.find((e) => e.type === 'effect-expired' && e.kind === 'barge');
  assert.ok(expired);
});

test('Shock actual radii are width * sizeMultiplier * base radius', () => {
  const world = shockSetup({ targetZ: 3 });
  const dome = world.effects.find((e) => e.kind === 'shock');
  assert.equal(dome.baseOuterRadius, 14);
  assert.equal(dome.totalOuterRadius, 0.5 * 1.0 * 14);
  assert.equal(dome.totalInnerRadius, 0.5 * 1.0 * 7);
  assert.equal(dome.appliedDamage, 50);
});

test('Shock falloff: every hit inside the growing outer sphere does 50 (no falloff)', () => {
  const world = makeWorld();
  world.addCar('p1', { position: { x: 0, y: 0, z: -50 }, radiusM: 1.0 });
  world.addCar('p2', { position: { x: 0, y: 0, z: 1 }, radiusM: 1.0 });
  world.addCar('p3', { position: { x: 0, y: 0, z: 6.5 }, radiusM: 1.0 });
  world.addInventory('p1', 'Shock', 1);
  world.fireShock({
    ownerId: 'p1', targetId: 'p2',
    domes: [{ position: { x: 0, y: 0, z: 0 }, width: 0.5, sizeMultiplier: 1.0 }],
  });
  world.advance(0.75);
  assert.equal(world.cars.get('p2').health, 50);
  assert.equal(world.cars.get('p3').health, 50);
  const hits = world.events.filter((e) => e.type === 'shock-hit');
  assert.equal(hits.length, 2);
  for (const hit of hits) assert.equal(hit.hitType, 'minor');
});

test('Shock growth: a 5 m target is missed early and hit after the sphere grows', () => {
  const world = shockSetup({ targetZ: 5 });
  world.advance(0.2);
  assert.equal(world.cars.get('p2').health, 100);
  world.advance(0.3);
  assert.equal(world.cars.get('p2').health, 50);
});

test('Shock height gate: a target 2 m below the dome is not hit', () => {
  const world = shockSetup({ targetZ: 1, targetY: -2 });
  world.advance(0.5);
  assert.equal(world.cars.get('p2').health, 100);
  assert.ok(!world.events.some((e) => e.type === 'shock-hit'));
});

test('Shock expire: the dome ends at its lifetime and outside-outer target is untouched', () => {
  const world = shockSetup({ targetZ: 8 });
  world.advance(1.6);
  assert.equal(world.cars.get('p2').health, 100);
  const expired = world.events.find((e) => e.type === 'effect-expired' && e.kind === 'shock');
  assert.ok(expired);
});

test('Shock without dome layout is refused, not guessed', () => {
  const world = makeWorld();
  world.addCar('p1', { position: { x: 0, y: 0, z: 0 }, radiusM: 1.0 });
  world.addInventory('p1', 'Shock', 1);
  const ev = world.fireShock({ ownerId: 'p1' });
  assert.equal(ev.type, 'shock-rejected');
  assert.equal(ev.reason, 'missing-dome-layout');
  assert.equal(ev.missing.status, 'runtime-only');
});

test('events are sequenced, authoritative and deterministic for the same inputs', () => {
  function run() {
    const world = blindfireSetup();
    world.fireBlindfire({ ownerId: 'p1', direction: { x: 0, y: 0, z: 1 } });
    world.advance(0.1);
    return world;
  }
  const a = run();
  const b = run();
  assert.equal(JSON.stringify(a.snapshot()), JSON.stringify(b.snapshot()));
  for (const [index, event] of a.events.entries()) {
    assert.equal(event.seq, index + 1);
    assert.equal(event.authority, 'host-A');
  }
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} tests passed`);
if (failed.length) {
  console.error('failures:', failed.map((f) => f.name).join(', '));
  process.exit(1);
}
