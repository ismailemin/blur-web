/**
 * Unit tests for the SS1 typed SuperShield model.
 *
 * Run:
 *   node probes/powerups/rules/supershield.test.mjs
 *   node probes/powerups/rules/supershield.test.mjs --manifest _work/powerups/supershield.json
 *
 * The tests read the recovered manifest; they do not contain game values of
 * their own. If the manifest is missing, the run fails with the build command.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createSuperShieldModel, recoveredValues } from './supershield.js';

const args = process.argv.slice(2);
const manifestArg = args.includes('--manifest')
  ? args[args.indexOf('--manifest') + 1]
  : resolve(process.cwd(), '_work/powerups/supershield.json');

if (!existsSync(manifestArg)) {
  console.error(`manifest not found: ${manifestArg}`);
  console.error('run: python probes/powerups/tools/build_supershield.py');
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

function makeWorld(options = {}) {
  const world = createSuperShieldModel(manifest, { authorityId: 'host-A', ...options });
  world.addCar('p1', { health: 1000, maxHealth: 1000, massKg: 1600, position: { x: 1, y: 2, z: 3 } });
  world.addCar('p2', { health: 1000, maxHealth: 1000, massKg: 1500, position: { x: -1, y: 2, z: 3 } });
  return world;
}

function activate(world, ownerId = 'p1', request = {}) {
  const shield = world.activate(ownerId, { pickupId: 'pk-1', ...request });
  assert.equal(shield.active, true);
  return shield;
}

const values = recoveredValues(manifest);

test('manifest integrity and typed field statuses', () => {
  assert.equal(manifest.schema, 'blur-powerups-supershield/1');
  assert.equal(manifest.entity.pickupLabel, 'SuperShield');
  assert.equal(manifest.entity.record, 619);
  assert.equal(manifest.entity.refId, 3093073274);
  assert.equal(manifest.entity.normal.record, 523);
  assert.equal(manifest.balancing.type, 'SuperShieldBalancingData');
  assert.equal(values.Lifetime, 10);
  assert.equal(values.DamagePointsOnImpact, 100);
  assert.equal(values.IncreasedMass, 10000);
  assert.equal(values.NitroTargetSpeedInMPH, 50);
  assert.equal(values.Health, 50);
  assert.equal(manifest.balancing.fields.Health.status, 'serialized-unused');
  assert.equal(manifest.balancing.fields.BrakingBoost.status, 'serialized-unused');
  assert.equal(manifest.multiplayer.enabled, false);
  assert.equal(manifest.multiplayer.wire.pickupFiredTypeNibble, 10);
  assert.equal(manifest.hud.entry.texture_index, 104);
  assert.equal(manifest.audio.superShieldEntity, null);
});

test('activate: lifetime, mass, weight class, unused health, nitro target', () => {
  const world = makeWorld();
  const shield = activate(world);
  assert.equal(shield.lifetimeSeconds, 10);
  assert.equal(shield.massBeforeKg, 1600);
  assert.equal(shield.massActiveKg, 10000);
  assert.equal(world.car('p1').massKg, 10000);
  assert.equal(shield.weightClass, 'Ultra');
  assert.equal(shield.healthField.value, 50);
  assert.equal(shield.healthField.status, 'serialized-unused');
  const event = world.events.at(-1);
  assert.equal(event.type, 'supershield-activated');
  assert.equal(event.authority, 'host-A');
  assert.equal(event.massKgBefore, 1600);
  assert.equal(event.massActiveKg, 10000);
  assert.equal(event.nitro.targetMph, 50);
  assert.ok(Math.abs(event.nitro.targetMps - 22.352) < 1e-9);
  assert.equal(event.boosts.brakingBoost.status, 'serialized-unused');
  assert.equal(event.hud.textureIndex, 104);
  assert.equal(event.audio.entity, null);
  assert.equal(event.wireTypeNibble, 10);
});

test('absorb: unlimited within lifetime, health unchanged', () => {
  const world = makeWorld();
  activate(world);
  const result = world.hit('p1', 1000, { pickupType: 'Blindfire' });
  assert.equal(result.status, 'absorbed');
  assert.equal(result.absorbed, 1000);
  assert.equal(result.leaked, 0);
  assert.equal(world.car('p1').health, 1000);
  const event = world.events.at(-1);
  assert.equal(event.type, 'supershield-absorbed');
  assert.equal(event.attemptedDamage, 1000);
  assert.equal(event.absorbedDamage, 1000);
  assert.equal(event.healthUnchanged, true);
  assert.equal(event.cap, null);
  assert.equal(event.absorbModel, 'time-invulnerability');
});

test('absorb then expire: mass revert and post-expiry damage passes', () => {
  const world = makeWorld();
  activate(world);
  world.hit('p1', 100, { pickupType: 'Shunt' });
  world.hit('p1', 200, { pickupType: 'Shock' });
  world.advance(9.9);
  const beforeExpiry = world.hit('p1', 500, { pickupType: 'Barge' });
  assert.equal(beforeExpiry.absorbed, 500);
  world.advance(0.1);
  const expired = world.events.find((event) => event.type === 'supershield-expired');
  assert.ok(expired);
  assert.equal(expired.reason, 'lifetime');
  assert.equal(expired.massKgRevertedTo, 1600);
  assert.equal(world.car('p1').massKg, 1600);
  assert.equal(world.shield('p1').active, false);
  const afterExpiry = world.hit('p1', 50, { pickupType: 'Blindfire' });
  assert.equal(afterExpiry.status, 'damaged');
  assert.equal(world.car('p1').health, 950);
});

test('activate while active: replaced, no refresh', () => {
  const world = makeWorld();
  activate(world);
  world.advance(2);
  const before = world.shield('p1').remainingSeconds;
  const event = world.activate('p1', { pickupId: 'pk-2' });
  assert.equal(event.type, 'supershield-replaced');
  assert.equal(event.refreshed, false);
  assert.equal(event.reason, 'already-active');
  assert.equal(world.shield('p1').remainingSeconds, before);
});

test('activate without original mass is a typed rejection', () => {
  const world = makeWorld();
  world.cars.get('p1').massKg = null;
  const event = world.activate('p1', { pickupId: 'pk-1' });
  assert.equal(event.type, 'supershield-rejected');
  assert.equal(event.reason, 'missing-original-mass');
  assert.equal(event.missing.status, 'runtime-engine-data');
  assert.equal(world.shield('p1'), null);
});

test('Nitrous bypasses the shield (excluded type)', () => {
  const world = makeWorld();
  activate(world);
  const result = world.hit('p1', 100, { pickupType: 'Nitrous' });
  assert.equal(result.status, 'bypassed');
  assert.equal(result.absorbed, 0);
  assert.equal(world.car('p1').health, 1000);
  assert.ok(world.events.some((event) => event.type === 'supershield-bypassed'));
});

test('ram: contact damage is capped at DamagePointsOnImpact and jink side comes from the caller dot', () => {
  const world = makeWorld();
  activate(world);
  const damage = world.ram('p1', 'p2', { relativeDotLeft: -0.5 });
  assert.equal(damage, values.DamagePointsOnImpact);
  assert.equal(world.car('p2').health, 1000 - values.DamagePointsOnImpact);
  const event = world.events.find((e) => e.type === 'supershield-rammed');
  assert.equal(event.damage, 100);
  assert.equal(event.damageCap, 100);
  assert.equal(event.jink, 'jink-shield-left');
  assert.equal(event.cooldownSeconds, 1);
  const right = world.ram('p1', 'p2', { relativeDotLeft: 0.5 });
  assert.equal(right.type, 'supershield-ram-ignored');
  assert.equal(right.reason, 'cooldown');
});

test('ram cooldown: 1.0 s per rammer, then damage again', () => {
  const world = makeWorld();
  activate(world);
  world.ram('p1', 'p2', { relativeDotLeft: 0.2 });
  world.advance(0.5);
  const ignored = world.ram('p1', 'p2', { relativeDotLeft: 0.2 });
  assert.equal(ignored.type, 'supershield-ram-ignored');
  assert.equal(ignored.reason, 'cooldown');
  assert.ok(ignored.cooldownRemainingSeconds > 0.4);
  world.advance(0.5);
  const again = world.ram('p1', 'p2', { relativeDotLeft: 0.2 });
  assert.equal(again, 100);
  assert.equal(world.car('p2').health, 800);
});

test('ram: both shielded means no damage and no cooldown', () => {
  const world = makeWorld();
  activate(world);
  activate(world, 'p2', { pickupId: 'pk-2' });
  const result = world.ram('p1', 'p2', { relativeDotLeft: 0 });
  assert.equal(result.type, 'supershield-ram-ignored');
  assert.equal(result.reason, 'both-shielded');
  assert.equal(result.damage, 0);
  assert.equal(world.car('p2').health, 1000);
  assert.equal(world.ramCooldowns.size, 0);
});

test('ram without a relative dot is refused, not guessed', () => {
  const world = makeWorld();
  activate(world);
  const result = world.ram('p1', 'p2');
  assert.equal(result.type, 'supershield-ram-rejected');
  assert.equal(result.reason, 'missing-relative-dot');
  assert.equal(result.missing.status, 'runtime-only');
  assert.equal(world.car('p2').health, 1000);
});

test('boosts: impulses use serialized magnitudes and the 2.5 m steering offset', () => {
  const world = makeWorld();
  activate(world);
  const out = world.applyBoosts('p1', {
    steeringInput: 0.5,
    throttleInput: 1,
    axes: { left: { x: 1, y: 0, z: 0 }, forward: { x: 0, y: 0, z: 1 }, up: { x: 0, y: 1, z: 0 } },
  });
  assert.equal(out.steeringImpulse.x, 500);
  assert.equal(out.accelerationImpulse.z, 1500);
  assert.equal(out.downForceImpulse.y, -5000);
  assert.equal(out.steeringApplicationPoint.z, 3 + 2.5);
  assert.equal(out.throttleNormalised, 1);
  const event = world.events.at(-1);
  assert.equal(event.type, 'supershield-boost-applied');
  assert.equal(event.brakingBoostStatus, 'serialized-unused');
});

test('trigger normalisation: 0.5 is dead, 0.75 is half, brake uses AccelerationBoost', () => {
  const world = makeWorld();
  activate(world);
  const dead = world.applyBoosts('p1', { throttleInput: 0.5 });
  assert.equal(dead.throttleNormalised, 0);
  const half = world.applyBoosts('p1', { throttleInput: 0.75 });
  assert.equal(half.throttleNormalised, 0.5);
  const brake = world.applyBoosts('p1', { brakeInput: 1 });
  assert.equal(brake.throttleNormalised, -1);
  assert.equal(brake.accelerationImpulse.z, -1500);
});

test('BrakingBoost is serialized-unused: brake still uses AccelerationBoost', () => {
  const clone = JSON.parse(JSON.stringify(manifest));
  clone.balancing.fields.BrakingBoost.value = 9999;
  const world = createSuperShieldModel(clone, { authorityId: 'host-A' });
  world.addCar('p1', { health: 1000, massKg: 1600 });
  world.activate('p1', { pickupId: 'pk-1' });
  const out = world.applyBoosts('p1', { brakeInput: 1 });
  assert.equal(out.accelerationImpulse.z, -clone.balancing.fields.AccelerationBoost.value);
  assert.notEqual(out.accelerationImpulse.z, -9999);
  assert.equal(out.steeringImpulse.x, 0);
});

test('provisional absorb cap: opt-in, leaks, expires, labelled provisional', () => {
  const world = makeWorld();
  activate(world, 'p1', { provisionalAbsorbCap: 150 });
  const first = world.hit('p1', 100, { pickupType: 'Shunt' });
  assert.equal(first.absorbed, 100);
  assert.equal(first.leaked, 0);
  const second = world.hit('p1', 100, { pickupType: 'Shunt' });
  assert.equal(second.absorbed, 50);
  assert.equal(second.leaked, 50);
  assert.equal(world.car('p1').health, 950);
  assert.equal(world.shield('p1').active, false);
  const expired = world.events.find((e) => e.type === 'supershield-expired');
  assert.equal(expired.reason, 'provisional-damage-cap');
  const absorbed = world.events.filter((e) => e.type === 'supershield-absorbed');
  assert.equal(absorbed[1].provisional, true);
  assert.equal(absorbed[1].cap.status, 'provisional');
});

test('event sequence, authority, and snapshot determinism', () => {
  const run = () => {
    const world = makeWorld();
    activate(world);
    world.hit('p1', 50, { pickupType: 'Blindfire' });
    world.ram('p1', 'p2', { relativeDotLeft: -0.1 });
    world.applyBoosts('p1', { throttleInput: 1 });
    world.advance(2);
    return world;
  };
  const a = run();
  const b = run();
  assert.deepEqual(a.snapshot(), b.snapshot());
  assert.deepEqual(a.events, b.events);
  for (let i = 0; i < a.events.length; i += 1) {
    assert.equal(a.events[i].seq, i + 1);
    assert.equal(a.events[i].authority, 'host-A');
  }
  assert.deepEqual(a.snapshot().shields.map((s) => s.ownerId), ['p1']);
  assert.equal(a.snapshot().cars.find((c) => c.id === 'p1').massKg, 10000);
});

test('damage after expiry and reactivation restores a fresh 10 s shield', () => {
  const world = makeWorld();
  activate(world);
  world.advance(10);
  assert.equal(world.shield('p1').active, false);
  world.hit('p1', 25, { pickupType: 'Shunt' });
  assert.equal(world.car('p1').health, 975);
  const again = activate(world, 'p1', { pickupId: 'pk-3' });
  assert.equal(again.active, true);
  assert.equal(again.remainingSeconds, 10);
  assert.equal(world.car('p1').massKg, 10000);
  assert.equal(world.ramCooldowns.size, 0);
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} PASS`);
if (failed.length) {
  console.error(failed.map((r) => `- ${r.name}: ${r.error}`).join('\n'));
  process.exit(1);
}
