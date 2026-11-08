// Unit tests for the deterministic AI power-up policy.
//
// Run: node probes/ai-driver/rules/ai-powerups.test.mjs
// No engine, no game data, no browser. Every test is a pure policy call.

import assert from 'node:assert/strict';
import {
  AI_PROFILE_DIFFICULTY, RECOVERED_AI_CONTROLLER, RECOVERED_AI_TRIGGERS,
  SUPPORTED_MP_TYPES, createAiPowerupPolicy, hashOf,
} from './ai-powerups.mjs';

let passed = 0;
let failed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const selfBase = (overrides = {}) => ({
  id: 'ai-1', position: { x: 0, z: 0 }, heading: 0, speed: 20,
  health: 100, maxHealth: 100, alive: true, finished: false,
  inventory: [], inventoryCapacity: 1, effects: [], steer: 0,
  ...overrides,
});
const opponent = (id, x, z, overrides = {}) => ({
  id, position: { x, z }, heading: Math.PI, speed: 20, alive: true,
  racePosition: 2, ...overrides,
});
const useTypes = (decision) => decision.intents.filter((i) => i.kind === 'use')
  .map((i) => i.pickupType);

test('recovered controller has five serialized difficulty rows', () => {
  assert.deepEqual(Object.keys(RECOVERED_AI_CONTROLLER.difficulties),
    ['VeryEasy', 'Easy', 'Normal', 'Hard', 'HardCore']);
  assert.equal(RECOVERED_AI_CONTROLLER.difficulties.Normal.setupRecord, 153);
  assert.equal(RECOVERED_AI_CONTROLLER.difficulties.Normal.setupRefId, 742508891);
  assert.equal(RECOVERED_AI_CONTROLLER.difficulties.Easy.pickupSwitchSeconds, 3);
  assert.equal(RECOVERED_AI_CONTROLLER.difficulties.Hard.pickupSwitchSeconds, 1);
});

test('three supported profiles map to three retail difficulty rows', () => {
  assert.equal(AI_PROFILE_DIFFICULTY.cautious, 'Easy');
  assert.equal(AI_PROFILE_DIFFICULTY.standard, 'Normal');
  assert.equal(AI_PROFILE_DIFFICULTY.reference, 'Hard');
});

test('eight multiplayer types are supported; Fan/Stopwatch/SuperShield are not', () => {
  const policy = createAiPowerupPolicy({ profileId: 'reference' });
  assert.deepEqual(policy.supported, [...SUPPORTED_MP_TYPES].sort());
  assert.equal(policy.supported.includes('SuperShield'), false);
  assert.equal(policy.supported.includes('Fan'), false);
  assert.equal(policy.supported.includes('Stopwatch'), false);
});

test('pickup acquired only inside the 2.0 m pickup radius', () => {
  const policy = createAiPowerupPolicy({ profileId: 'reference' });
  const near = policy.decide({ tick: 0, self: selfBase(),
    pickups: [{ id: 'p1', type: 'Shunt', state: 'active', position: { x: 0, z: 1.9 } }],
    opponents: [], events: [] });
  assert.deepEqual(near.intents.map((i) => i.kind), ['pickup']);
  const far = policy.decide({ tick: 1, self: selfBase(),
    pickups: [{ id: 'p1', type: 'Shunt', state: 'active', position: { x: 0, z: 2.1 } }],
    opponents: [], events: [] });
  assert.deepEqual(far.intents, []);
});

test('slot limit blocks a second pickup intent', () => {
  const policy = createAiPowerupPolicy({ profileId: 'reference' });
  const decision = policy.decide({ tick: 0,
    self: selfBase({ inventory: [{ type: 'Shunt', level: 'Normal' }] }),
    pickups: [{ id: 'p1', type: 'Shield', state: 'active', position: { x: 0, z: 1 } }],
    opponents: [], events: [] });
  assert.deepEqual(decision.intents, []);
});

test('unsupported pickup is skipped with a typed reason, not collected', () => {
  const policy = createAiPowerupPolicy({ profileId: 'reference' });
  const decision = policy.decide({ tick: 0, self: selfBase(),
    pickups: [{ id: 'p1', type: 'Fan', state: 'active', position: { x: 0, z: 1 } }],
    opponents: [], events: [] });
  assert.deepEqual(decision.intents, []);
  assert.equal(decision.diagnostics[0].reason, 'unsupported-type');
  assert.equal(decision.diagnostics[0].detail.source, 'capabilities');
});

test('pickup switch cadence follows the recovered difficulty setup', () => {
  const cautious = createAiPowerupPolicy({ profileId: 'cautious' });
  const standard = createAiPowerupPolicy({ profileId: 'standard' });
  const reference = createAiPowerupPolicy({ profileId: 'reference' });
  const input = (tick) => ({ tick, self: selfBase(),
    pickups: [{ id: 'p1', type: 'Nitrous', state: 'active', position: { x: 0, z: 1 } }],
    opponents: [], events: [] });
  assert.equal(cautious.ticks.pickupSwitch, 180);
  assert.equal(standard.ticks.pickupSwitch, 120);
  assert.equal(reference.ticks.pickupSwitch, 60);
  assert.equal(cautious.decide(input(0)).intents.length, 1);
  assert.equal(cautious.decide(input(179)).intents.length, 0);
  assert.equal(cautious.decide(input(180)).intents.length, 1);
});

test('Shunt fires at a target ahead and refuses a target behind', () => {
  const policy = createAiPowerupPolicy({ profileId: 'reference' });
  const ahead = policy.decide({ tick: 0,
    self: selfBase({ inventory: [{ type: 'Shunt', level: 'Normal' }] }),
    opponents: [opponent('opp', 0, 30)], events: [] });
  assert.deepEqual(useTypes(ahead), ['Shunt']);
  assert.equal(ahead.intents[0].targetId, 'opp');
  assert.equal(ahead.intents[0].aim.source, 'provisional');
  assert.equal(ahead.intents[0].aim.leadSeconds, 0);
  const behind = createAiPowerupPolicy({ profileId: 'reference' }).decide({ tick: 0,
    self: selfBase({ inventory: [{ type: 'Shunt', level: 'Normal' }] }),
    opponents: [opponent('opp', 0, -30)], events: [] });
  assert.deepEqual(behind.intents, []);
  assert.equal(behind.diagnostics.at(-1).reason, 'no-target');
});

test('Shunt honours the serialized 40 m / 40 degree trigger tier', () => {
  const policy = createAiPowerupPolicy({ profileId: 'reference' });
  const wide = 45 * Math.PI / 180;
  const out = policy.decide({ tick: 0,
    self: selfBase({ inventory: [{ type: 'Shunt', level: 'Normal' }] }),
    opponents: [opponent('opp', Math.sin(wide) * 30, Math.cos(wide) * 30)], events: [] });
  assert.deepEqual(out.intents, []);
  const inside = 35 * Math.PI / 180;
  const yes = policy.decide({ tick: 30,
    self: selfBase({ inventory: [{ type: 'Shunt', level: 'Normal' }] }),
    opponents: [opponent('opp', Math.sin(inside) * 30, Math.cos(inside) * 30)], events: [] });
  assert.deepEqual(useTypes(yes), ['Shunt']);
});

test('Blindfire fires forward without a target id', () => {
  const policy = createAiPowerupPolicy({ profileId: 'reference' });
  const decision = policy.decide({ tick: 0,
    self: selfBase({ inventory: [{ type: 'Blindfire', level: 'Normal' }] }),
    opponents: [opponent('opp', 0, 25)], events: [] });
  assert.deepEqual(useTypes(decision), ['Blindfire']);
  assert.equal(decision.intents[0].targetId, null);
  assert.equal(decision.intents[0].triggerTargetId, 'opp');
  assert.equal(decision.intents[0].aim.mode, 'forward');
});

test('Shock selects the lowest race position among ahead targets', () => {
  const policy = createAiPowerupPolicy({ profileId: 'reference' });
  const decision = policy.decide({ tick: 0,
    self: selfBase({ inventory: [{ type: 'Shock', level: 'Normal' }] }),
    opponents: [opponent('near', 0, 50, { racePosition: 2 }),
      opponent('leader', 0, 100, { racePosition: 1 })], events: [] });
  assert.deepEqual(useTypes(decision), ['Shock']);
  assert.equal(decision.intents[0].targetId, 'leader');
});

test('Bomb drops behind at the serialized 5 m place-behind distance', () => {
  const policy = createAiPowerupPolicy({ profileId: 'reference' });
  const decision = policy.decide({ tick: 0,
    self: selfBase({ inventory: [{ type: 'Bomb', level: 'Normal' }] }),
    opponents: [opponent('chaser', 0, -20)], events: [] });
  assert.deepEqual(useTypes(decision), ['Bomb']);
  assert.equal(decision.intents[0].position.z, -5);
  assert.equal(decision.intents[0].drop.source, 'serialized');
  const none = createAiPowerupPolicy({ profileId: 'reference' }).decide({ tick: 0,
    self: selfBase({ inventory: [{ type: 'Bomb', level: 'Normal' }] }),
    opponents: [opponent('ahead', 0, 20)], events: [] });
  assert.deepEqual(none.intents, []);
  assert.equal(none.diagnostics.at(-1).reason, 'no-target');
});

test('Barge uses the serialized 7.0 m radius plus the runtime +0.5 m', () => {
  const inside = createAiPowerupPolicy({ profileId: 'reference' }).decide({ tick: 0,
    self: selfBase({ inventory: [{ type: 'Barge', level: 'Normal' }] }),
    opponents: [opponent('opp', 7.4, 0)], events: [] });
  assert.deepEqual(useTypes(inside), ['Barge']);
  assert.equal(inside.intents[0].radiusMetres, 7.5);
  const outside = createAiPowerupPolicy({ profileId: 'reference' }).decide({ tick: 0,
    self: selfBase({ inventory: [{ type: 'Barge', level: 'Normal' }] }),
    opponents: [opponent('opp', 7.6, 0)], events: [] });
  assert.deepEqual(outside.intents, []);
});

test('Shield reacts to an incoming projectile event on the 0.1 s cadence', () => {
  const policy = createAiPowerupPolicy({ profileId: 'reference' });
  const decision = policy.decide({ tick: 6,
    self: selfBase({ inventory: [{ type: 'Shield', level: 'Normal' }] }),
    opponents: [], events: [{ type: 'projectile-fired', tick: 0, playerId: 'enemy', targetId: 'ai-1' }] });
  assert.deepEqual(useTypes(decision), ['Shield']);
  assert.equal(decision.intents[0].reason, 'incoming-threat');
  const none = createAiPowerupPolicy({ profileId: 'reference' }).decide({ tick: 6,
    self: selfBase({ inventory: [{ type: 'Shield', level: 'Normal' }] }),
    opponents: [], events: [] });
  assert.deepEqual(none.intents, []);
});

test('Shield does not re-activate while already active', () => {
  const policy = createAiPowerupPolicy({ profileId: 'reference' });
  const decision = policy.decide({ tick: 6,
    self: selfBase({ inventory: [{ type: 'Shield', level: 'Normal' }],
      effects: [{ kind: 'shield', ownerId: 'ai-1', expiresAt: 10 }] }),
    opponents: [], events: [{ type: 'projectile-fired', tick: 0, playerId: 'enemy', targetId: 'ai-1' }] });
  assert.deepEqual(decision.intents, []);
});

test('Repair is used only when damaged', () => {
  const damaged = createAiPowerupPolicy({ profileId: 'reference' }).decide({ tick: 0,
    self: selfBase({ inventory: [{ type: 'Repair', level: 'Normal' }], health: 60 }),
    opponents: [], events: [] });
  assert.deepEqual(useTypes(damaged), ['Repair']);
  const full = createAiPowerupPolicy({ profileId: 'reference' }).decide({ tick: 0,
    self: selfBase({ inventory: [{ type: 'Repair', level: 'Normal' }], health: 100 }),
    opponents: [], events: [] });
  assert.deepEqual(full.intents, []);
  assert.equal(full.diagnostics.at(-1).reason, 'not-needed');
});

test('Nitrous is used only above the provisional min speed on a straight', () => {
  const fast = createAiPowerupPolicy({ profileId: 'reference' }).decide({ tick: 0,
    self: selfBase({ inventory: [{ type: 'Nitrous', level: 'Normal' }], speed: 20 }),
    opponents: [], events: [] });
  assert.deepEqual(useTypes(fast), ['Nitrous']);
  const slow = createAiPowerupPolicy({ profileId: 'reference' }).decide({ tick: 0,
    self: selfBase({ inventory: [{ type: 'Nitrous', level: 'Normal' }], speed: 5 }),
    opponents: [], events: [] });
  assert.deepEqual(slow.intents, []);
  assert.equal(slow.diagnostics.at(-1).reason, 'out-of-range');
});

test('two-second fired-perk disable prevents a second use', () => {
  const policy = createAiPowerupPolicy({ profileId: 'reference' });
  const self = () => selfBase({ inventory: [{ type: 'Shunt', level: 'Normal' }] });
  const input = (tick) => ({ tick, self: self(),
    opponents: [opponent('opp', 0, 20)], events: [] });
  assert.deepEqual(useTypes(policy.decide(input(0))), ['Shunt']);
  assert.deepEqual(policy.decide(input(30)).intents, []);
  assert.deepEqual(policy.decide(input(119)).intents, []);
  assert.deepEqual(useTypes(policy.decide(input(120))), ['Shunt']);
});

test('five-second player-hit disable blocks perk use', () => {
  const policy = createAiPowerupPolicy({ profileId: 'reference' });
  const input = (tick, events = []) => ({ tick,
    self: selfBase({ inventory: [{ type: 'Shunt', level: 'Normal' }] }),
    opponents: [opponent('opp', 0, 20)], events });
  assert.deepEqual(policy.decide(input(0, [{ type: 'damage', tick: 0, targetId: 'ai-1', amount: 10 }])).intents, []);
  assert.deepEqual(policy.decide(input(299)).intents, []);
  assert.deepEqual(useTypes(policy.decide(input(300))), ['Shunt']);
});

test('a wrecked or finished car emits no intents', () => {
  const wrecked = createAiPowerupPolicy({ profileId: 'reference' }).decide({ tick: 0,
    self: selfBase({ alive: false, inventory: [{ type: 'Shunt', level: 'Normal' }] }),
    opponents: [opponent('opp', 0, 20)], events: [] });
  assert.deepEqual(wrecked.intents, []);
  assert.equal(wrecked.phase, 'wrecked');
  const finished = createAiPowerupPolicy({ profileId: 'reference' }).decide({ tick: 0,
    self: selfBase({ finished: true, inventory: [{ type: 'Shunt', level: 'Normal' }] }),
    opponents: [opponent('opp', 0, 20)], events: [] });
  assert.deepEqual(finished.intents, []);
  assert.equal(finished.phase, 'finished');
});

test('unsupported capability (Shock omitted) skips with a typed reason', () => {
  const policy = createAiPowerupPolicy({ profileId: 'reference',
    capabilities: { types: ['Nitrous', 'Shunt', 'Blindfire', 'Barge', 'Bomb', 'Repair', 'Shield'] } });
  const decision = policy.decide({ tick: 0,
    self: selfBase({ inventory: [{ type: 'Shock', level: 'Normal' }] }),
    opponents: [opponent('opp', 0, 30)], events: [] });
  assert.deepEqual(decision.intents, []);
  assert.equal(decision.diagnostics.at(-1).reason, 'unsupported-type');
});

test('SuperShield is an extension: off by default, usable when enabled', () => {
  const off = createAiPowerupPolicy({ profileId: 'reference' }).decide({ tick: 6,
    self: selfBase({ inventory: [{ type: 'SuperShield', level: 'Normal' }] }),
    opponents: [], events: [{ type: 'projectile-fired', tick: 0, playerId: 'enemy', targetId: 'ai-1' }] });
  assert.deepEqual(off.intents, []);
  assert.equal(off.diagnostics.at(-1).reason, 'unsupported-type');
  const on = createAiPowerupPolicy({ profileId: 'reference',
    capabilities: { types: [...SUPPORTED_MP_TYPES, 'SuperShield'], superShield: true } }).decide({ tick: 6,
    self: selfBase({ inventory: [{ type: 'SuperShield', level: 'Normal' }] }),
    opponents: [], events: [{ type: 'projectile-fired', tick: 0, playerId: 'enemy', targetId: 'ai-1' }] });
  assert.deepEqual(useTypes(on), ['SuperShield']);
  assert.equal(on.intents[0].shield.extension, true);
});

test('all eight multiplayer types have a serialized trigger record', () => {
  for (const type of SUPPORTED_MP_TYPES) {
    assert.ok(RECOVERED_AI_TRIGGERS[type], `${type} has no recovered trigger table`);
  }
});

test('deterministic decision hash for an identical call sequence', () => {
  const run = () => {
    const policy = createAiPowerupPolicy({ profileId: 'reference' });
    const hashes = [];
    for (let tick = 0; tick < 300; tick += 1) {
      const decision = policy.decide({ tick,
        self: selfBase({ inventory: tick < 120 ? [{ type: 'Shunt', level: 'Normal' }] : [] }),
        opponents: [opponent('opp', 0, 20)], events: [] });
      hashes.push(decision.hash);
    }
    return hashes;
  };
  const first = run();
  const second = run();
  assert.deepEqual(first, second);
  assert.equal(new Set(first).size > 1, true);
});

test('different difficulties produce different decision hashes', () => {
  const make = (profileId) => createAiPowerupPolicy({ profileId }).decide({ tick: 0,
    self: selfBase(), pickups: [], opponents: [], events: [] });
  assert.notEqual(make('cautious').hash, make('reference').hash);
});

test('canonical hash is key-order independent', () => {
  assert.equal(hashOf({ b: 1, a: 2 }), hashOf({ a: 2, b: 1 }));
});

for (const entry of tests) {
  try {
    entry.fn();
    passed += 1;
    console.log(`PASS ${entry.name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${entry.name}`);
    console.log(`     ${error.message}`);
  }
}
console.log(`\n${passed}/${tests.length} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
