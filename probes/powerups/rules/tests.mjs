/**
 * Unit tests for the power-up rules prototype.
 *
 * Run:
 *   node probes/powerups/rules/tests.mjs
 *   node probes/powerups/rules/tests.mjs --manifest _work/powerups/powerups.json
 *
 * The tests read the extracted manifest; they do not contain game values of
 * their own. If the manifest is missing, the run fails with the command that
 * produces it (no silent fallback to a synthetic fixture).
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createWorld, buildCatalog, UNKNOWNS } from './engine.js';

const args = process.argv.slice(2);
const manifestArg = args.includes('--manifest')
  ? args[args.indexOf('--manifest') + 1]
  : resolve(process.cwd(), '_work/powerups/powerups.json');

if (!existsSync(manifestArg)) {
  console.error(`manifest not found: ${manifestArg}`);
  console.error('run: python probes/powerups/tools/build_powerups.py');
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(manifestArg, 'utf8'));
const catalog = buildCatalog(manifest);

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

function entity(label) {
  const item = catalog.entities.get(label);
  assert.ok(item, `entity ${label} present`);
  return item;
}

function level(label, slot = 'Normal') {
  const item = entity(label).levels[slot];
  assert.ok(item, `${label}.${slot} present`);
  return item.values;
}

function makeWorld(playerPos, extra = {}) {
  const world = createWorld(manifest, { mode: 'Long', ...extra });
  world.addPlayer('p1', { position: playerPos ?? { x: 0, z: 0 }, maxHealth: 1000, health: 1000 });
  return world;
}

function collect(world, fn) {
  const start = world.events.length;
  fn();
  return world.events.slice(start);
}

// ---------------------------------------------------------------------------
test('manifest exposes 11 pickup types and typed unknowns', () => {
  assert.equal(manifest.entities.length, 11);
  assert.equal(manifest.counts.pickupTypes, 11);
  for (const label of ['Nitrous', 'Shock', 'Shunt', 'Blindfire', 'Barge', 'Bomb',
    'Repair', 'Shield', 'Fan', 'Stopwatch', 'SuperShield']) {
    entity(label);
  }
  assert.equal(UNKNOWNS.normalRespawnSeconds.status, 'not-serialized');
  assert.equal(UNKNOWNS.charges.status, 'absent-from-schema');
  assert.equal(UNKNOWNS.shieldAbsorbModel.status, 'prototype-assumption');
});

test('mine hit: victim inside Bomb.Radius takes Bomb.DamageInflicted', () => {
  const bomb = level('Bomb');
  const world = makeWorld({ x: 0, z: 0 });
  world.addPlayer('p2', { position: { x: bomb.Radius / 2, z: 0 }, health: 1000, maxHealth: 1000 });
  const mine = world.spawnPickup('Bomb', { x: 0, z: 0 });
  world.pickup(mine.id, 'p1');
  const useEvents = collect(world, () => world.use('p1', { position: { x: 0, z: 0 } }));
  const placed = useEvents.find((e) => e.type === 'mine-placed');
  assert.ok(placed, 'mine-placed event');
  assert.equal(placed.mine.radius, bomb.Radius);
  assert.equal(placed.mine.outerRadius, bomb.OuterRadius);
  assert.equal(placed.mine.damage, bomb.DamageInflicted);

  const p2Before = world.players.get('p2').health;
  const tickEvents = world.advance(bomb.MasterMinePrimeTimer + 0.01);
  const detonated = tickEvents.find((e) => e.type === 'mine-detonated');
  assert.ok(detonated, 'mine-detonated event');
  assert.deepEqual(detonated.directHits.sort(), ['p1', 'p2']);
  assert.equal(world.players.get('p2').health, p2Before - bomb.DamageInflicted);
});

test('mine miss: victim outside Bomb.OuterRadius is not damaged', () => {
  const bomb = level('Bomb');
  const world = makeWorld({ x: 0, z: 0 });
  world.addPlayer('p2', {
    position: { x: bomb.OuterRadius + 5, z: 0 }, health: 1000, maxHealth: 1000,
  });
  const mine = world.spawnPickup('Bomb', { x: 0, z: 0 });
  world.pickup(mine.id, 'p1');
  world.use('p1', { position: { x: 0, z: 0 } });
  world.advance(bomb.MasterMinePrimeTimer + 0.01);
  const before = world.players.get('p2').health;
  const events = world.advance(0.01);
  assert.equal(world.players.get('p2').health, before);
  assert.ok(!events.some((e) => e.type === 'mine-near-miss' && e.targetId === 'p2'));
});

test('shield absorb: Shield.Health absorbs, then breaks and passes damage', () => {
  const shield = level('Shield');
  const world = makeWorld();
  const pickup = world.spawnPickup('Shield', { x: 0, z: 0 });
  world.pickup(pickup.id, 'p1');
  const events = collect(world, () => world.use('p1'));
  const active = events.find((e) => e.type === 'shield-activated');
  assert.ok(active);
  assert.equal(active.effect.capacity, shield.Health);
  assert.equal(active.effect.expiresAt, shield.Lifetime);

  const first = world.damage('p1', shield.Health / 2);
  assert.equal(first.absorbed, shield.Health / 2);
  assert.equal(first.remaining, 0);
  assert.equal(world.players.get('p1').health, 1000);

  const second = world.damage('p1', shield.Health);
  assert.equal(second.absorbed, shield.Health / 2);
  assert.equal(second.remaining, shield.Health / 2);
  assert.equal(world.players.get('p1').health, 1000 - shield.Health / 2);
  assert.ok(second.events.some((e) => e.type === 'shield-broken'));
});

test('weapon expiry: Nitro.Duration and Shock.Lifetime remove the effect', () => {
  const nitro = level('Nitrous');
  const world = makeWorld();
  const pickup = world.spawnPickup('Nitrous', { x: 0, z: 0 });
  world.pickup(pickup.id, 'p1');
  world.use('p1');
  assert.equal(world.effects.length, 1);
  let events = world.advance(nitro.Duration - 0.01);
  assert.ok(!events.some((e) => e.type === 'effect-expired'));
  events = world.advance(0.02);
  const expired = events.find((e) => e.type === 'effect-expired');
  assert.ok(expired);
  assert.equal(expired.kind, 'nitro');
  assert.equal(world.effects.length, 0);

  const shock = level('Shock');
  const world2 = makeWorld();
  const pickup2 = world2.spawnPickup('Shock', { x: 0, z: 0 });
  world2.pickup(pickup2.id, 'p1');
  world2.use('p1');
  world2.advance(shock.Lifetime + 0.01);
  const shockExpired = world2.events.find((e) => e.type === 'effect-expired' && e.kind === 'shock');
  assert.ok(shockExpired);
});

test('pickup respawn: Long = deactivate timer + 5.0 s; Normal stays typed unknown', () => {
  const deactivate = catalog.system.deactivateSeconds;
  const longDelay = catalog.respawnDelays.Long;
  assert.ok(longDelay > 0);

  const world = createWorld(manifest, { mode: 'Long' });
  world.addPlayer('p1');
  const item = world.spawnPickup('Repair', { x: 0, z: 0 });
  world.pickup(item.id, 'p1');
  assert.equal(world.pickups.get(item.id).state, 'deactivated');
  assert.equal(world.pickups.get(item.id).respawnAt, deactivate + longDelay);

  world.advance(deactivate + longDelay - 0.01);
  assert.equal(world.pickups.get(item.id).state, 'deactivated');
  world.advance(0.02);
  assert.equal(world.pickups.get(item.id).state, 'active');
  assert.ok(world.events.some((e) => e.type === 'pickup-respawn'));

  const normal = createWorld(manifest, { mode: 'Normal' });
  normal.addPlayer('p1');
  const normalItem = normal.spawnPickup('Repair', { x: 0, z: 0 });
  const ev = normal.pickup(normalItem.id, 'p1');
  assert.equal(ev.respawn.status, 'unresolved');
  const tick = normal.advance(30);
  const unresolved = tick.find((e) => e.type === 'respawn-unresolved');
  assert.ok(unresolved);
  assert.equal(normal.pickups.get(normalItem.id).state, 'deactivated');
  assert.equal(unresolved.status, 'not-serialized');

  const configured = createWorld(manifest, { mode: 'Normal', normalRespawnSeconds: 7 });
  configured.addPlayer('p1');
  const item3 = configured.spawnPickup('Repair', { x: 0, z: 0 });
  configured.pickup(item3.id, 'p1');
  assert.equal(configured.pickups.get(item3.id).respawnAt, deactivate + 7);
});

test('inventory: capacity rejects a second pickup; deactivated pickup cannot be reused', () => {
  const world = makeWorld();
  const first = world.spawnPickup('Repair', { x: 0, z: 0 });
  const second = world.spawnPickup('Shield', { x: 1, z: 0 });
  assert.equal(world.pickup(first.id, 'p1').type, 'pickup');
  const rejected = world.pickup(second.id, 'p1');
  assert.equal(rejected.type, 'pickup-rejected');
  assert.equal(rejected.reason, 'inventory-full');
  const again = world.pickup(first.id, 'p1');
  assert.equal(again.type, 'pickup-rejected');
  assert.equal(again.reason, 'not-active');
});

test('events are sequenced and carry the authority id', () => {
  const world = createWorld(manifest, { mode: 'Long', authorityId: 'host-A' });
  world.addPlayer('p1');
  const item = world.spawnPickup('Nitrous', { x: 0, z: 0 });
  world.pickup(item.id, 'p1');
  world.use('p1');
  world.damage('p1', 1);
  for (const [index, event] of world.events.entries()) {
    assert.equal(event.seq, index + 1);
    assert.equal(event.authority, 'host-A');
  }
  assert.equal(world.snapshot().authority, 'host-A');
});

test('snapshot is deterministic for the same command sequence', () => {
  function run() {
    const world = createWorld(manifest, { mode: 'Long' });
    world.addPlayer('p1', { position: { x: 2, z: 3 } });
    const item = world.spawnPickup('Bomb', { x: 2, z: 3 });
    world.pickup(item.id, 'p1');
    world.use('p1', { position: { x: 2, z: 3 } });
    world.advance(0.5);
    return JSON.stringify(world.snapshot());
  }
  assert.equal(run(), run());
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} tests passed`);
if (failed.length) {
  console.error('failures:', failed.map((f) => f.name).join(', '));
  process.exit(1);
}
