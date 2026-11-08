// AI power-up evidence run for the River 310 m sprint and loop-01.
//
// It combines the existing deterministic AI driver with the human power-up world
// (`probes/powerups/rules/engine.js`, read only). The AI policy emits intents
// only; this harness is the host and applies them to the world after validating
// them. Nothing in e1-drive, powerups, tools, upstream or game-data is modified.
//
// Writes `_work/ai-driver/results-powerups.json`. Run it twice and copy the first
// file to `results-powerups.previous.json`, then run `verify-powerups.mjs`.
//
// Determinism: no Date, no performance.now, no Math.random. Every decision and
// every event is hashed with canonical JSON + SHA-256.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  SKILL_PROFILES, createAiDriver, layoutSummary, hashOf, aggregateHash,
  sha256Hex, stateIsFinite
} from './ai-driver.mjs';
import { createWorld } from '../powerups/rules/engine.js';
import {
  AI_POWERUP_POLICY_KIND, AI_POWERUP_POLICY_VERSION, AI_PROFILE_DIFFICULTY,
  RECOVERED_AI_CONTROLLER, RECOVERED_AI_TRIGGERS, SUPPORTED_MP_TYPES,
  createAiPowerupPolicy,
} from './rules/ai-powerups.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const OUT = path.join(ROOT, '_work/ai-driver');
const E1 = path.join(ROOT, '_work/e1-drive');
const MODULE = path.join(E1, 'module/e1_drive.mjs');
const WASM = path.join(E1, 'module/e1_drive.wasm');
const BUILD = path.join(E1, 'module/build.json');
const LEVEL = path.join(E1, 'Level.levelphysics');
const CARS = path.join(E1, 'cars.json');
const SPRINT_LAYOUT = path.join(E1, 'sprint.json');
const LAP_LAYOUT = path.join(E1, 'sprint-lap.json');
const AMBOY_LAYOUT = path.join(E1, 'amboy/layout.json');
const AMBOY_LEVEL = path.join(ROOT, 'game-data/Blur/levels/usa_amboy/Level.levelphysics');
const POWERUPS_MANIFEST = path.join(ROOT, '_work/powerups/powerups.json');
const PLACEMENTS = path.join(ROOT, '_work/powerups/placements.json');
const AMBOY_PLACEMENTS = path.join(ROOT, '_work/powerups/placements-amboy.json');
const RECOVERED_AI = path.join(OUT, 'recovered-ai-powerups.json');

const POST_FINISH_TICKS = 120;
const MAX_RACE_TICKS = { '310m': 3600, lap: 7200, amboy: 22000 };
const PICKUP_RADIUS = 2.0;
const INVENTORY_CAPACITY = 2; // host config; retail pickup-slot capacity is runtime-only
const round6 = (value) => Math.round(value * 1e6) / 1e6;
const CARS_FOR_POLICY = 'corvette-zr1-stock';

const args = process.argv.slice(2);
const option = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
};
const list = (value) => (value ? value.split(',').map((item) => item.trim()).filter(Boolean) : null);
const ONLY_SCENARIOS = list(option('--scenarios'));
const ONLY_PROFILES = list(option('--profiles'));

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function layoutStart(layout) {
  return { x: layout.course.spawn.x, z: layout.course.spawn.z,
    heading: layout.gates[0].headingRad };
}

function createEngineWorld(module, levelBytes, fieldBytes) {
  const levelPtr = module._malloc(levelBytes.length);
  const fieldsPtr = module._malloc(fieldBytes.length + 1);
  if (!levelPtr || !fieldsPtr) throw new Error('wasm malloc failed');
  module.HEAPU8.set(levelBytes, levelPtr);
  module.HEAPU8.set(fieldBytes, fieldsPtr);
  const createAt = (x, z, heading) => {
    const ok = module._e1_create(levelPtr, levelBytes.length, fieldsPtr, fieldBytes.length,
      x, z, heading);
    if (!ok) throw new Error('e1_create failed: ' + module.UTF8ToString(module._e1_last_error()));
  };
  const read = () => JSON.parse(module.UTF8ToString(module._e1_get_state()));
  const step = () => {
    if (!module._e1_step()) {
      throw new Error('e1_step failed: ' + module.UTF8ToString(module._e1_last_error()));
    }
  };
  const setInput = (input) => module._e1_set_input(input[0], input[1], input[2], input[3]);
  return { module, createAt, read, step, setInput };
}

function newMetrics() {
  return {
    runningTicks: 0, ticksWithAnyContact: 0, ticksWithAllFourContacts: 0,
    airborneTicks: 0, nanTicks: 0, maxLateralMetres: 0, maxSpeed: 0,
    minSpeed: Infinity, respawns: 0,
  };
}

function mergeMetrics(metrics, state, projection, countLateral = true) {
  metrics.runningTicks += 1;
  const contacts = Array.isArray(state.contacts) ? state.contacts : [0, 0, 0, 0];
  if (contacts.some((contact) => contact)) metrics.ticksWithAnyContact += 1;
  if (contacts.every((contact) => contact)) metrics.ticksWithAllFourContacts += 1;
  if (contacts.every((contact) => !contact)) metrics.airborneTicks += 1;
  if (!stateIsFinite(state)) metrics.nanTicks += 1;
  if (countLateral && projection) {
    metrics.maxLateralMetres = Math.max(metrics.maxLateralMetres, projection.distance);
  }
  if (Number.isFinite(state.speed)) {
    metrics.maxSpeed = Math.max(metrics.maxSpeed, state.speed);
    metrics.minSpeed = Math.min(metrics.minSpeed, state.speed);
  }
}

// ---------------------------------------------------------------------------
// Pickup scenarios. `provisional` slots are project choices on the measured
// arc; `recovered` slots use the shipped PickupPosition XZ unchanged.
// ---------------------------------------------------------------------------

const PROVISIONAL_310_PWR2 = {
  id: 'pwr2-provisional-6',
  source: 'PWR2 provisional 6-slot plan (arcs 40..280, Bomb/Shield/Repair)',
  status: 'provisional',
  arcs: [40, 90, 140, 190, 240, 280],
  types: ['Bomb', 'Shield', 'Repair', 'Bomb', 'Shield', 'Repair'],
};
const PROVISIONAL_310_8TYPE = {
  id: '8type-provisional-12',
  source: 'project extension: 12 measured-arc slots covering the 8 MP classes',
  status: 'provisional',
  arcs: [30, 55, 80, 105, 130, 155, 180, 205, 230, 255, 280, 300],
  types: ['Nitrous', 'Shock', 'Shunt', 'Blindfire', 'Barge', 'Bomb',
    'Repair', 'Shield', 'Nitrous', 'Shock', 'Shunt', 'Blindfire'],
};
const PROVISIONAL_LOOP_8TYPE = {
  id: '8type-provisional-12',
  source: 'project extension: 12 measured-loop arcs covering the 8 MP classes',
  status: 'provisional',
  arcs: [10, 30, 50, 70, 90, 110, 130, 150, 170, 190, 205, 220],
  types: ['Nitrous', 'Shock', 'Shunt', 'Blindfire', 'Barge', 'Bomb',
    'Repair', 'Shield', 'Nitrous', 'Shock', 'Shunt', 'Blindfire'],
};
const PROVISIONAL_AMBOY_8TYPE = {
  id: '8type-provisional-12',
  source: 'project extension: 12 measured-Amboy arcs covering the 8 MP classes',
  status: 'provisional',
  arcs: [100, 300, 500, 700, 900, 1100, 1300, 1500, 1700, 1900, 2000, 2050],
  types: ['Nitrous', 'Shock', 'Shunt', 'Blindfire', 'Barge', 'Bomb',
    'Repair', 'Shield', 'Nitrous', 'Shock', 'Shunt', 'Blindfire'],
};

const PICKUP_ALIAS = {
  Nos: 'Nitrous', Bolt: 'Blindfire', Mine: 'Bomb',
};

function normalizePickupLabel(label) {
  return PICKUP_ALIAS[label] ?? label;
}

function provisionalSlots(driver, scenario) {
  const slots = [];
  for (let index = 0; index < scenario.arcs.length; index++) {
    const arc = scenario.arcs[index];
    const point = driver.track.pointAt(arc);
    slots.push({
      type: scenario.types[index],
      position: { x: point.x, y: point.groundY ?? 0, z: point.z },
      arc,
      source: scenario.status,
    });
  }
  return slots;
}

function recoveredSlots(placementDoc, courseKey) {
  const placements = placementDoc.placements ?? [];
  return placements
    .filter((placement) => {
      const projection = placement.courseProjection?.[courseKey];
      return projection && projection.distance <= PICKUP_RADIUS;
    })
    .map((placement) => ({
      type: normalizePickupLabel(placement.serializedType?.name ?? placement.name),
      position: placement.position,
      uid: placement.uid,
      distanceMetres: round6(placement.courseProjection[courseKey].distance),
      arc: round6(placement.courseProjection[courseKey].arc),
      source: 'recovered',
    }));
}

function amboyRecoveredSlots(placementDoc) {
  const routes = placementDoc.authority?.routes ?? [];
  const raced = routes.filter((route) => (route.racingRaceCount ?? 0) > 0);
  const placements = raced.flatMap((route) => route.placements ?? []);
  return placements
    .filter((placement) => (placement.courseProjection?.measuredLayout?.distance ?? Infinity) <= PICKUP_RADIUS)
    .map((placement) => ({
      type: normalizePickupLabel(placement.serializedType?.name ?? placement.name),
      position: placement.position,
      uid: placement.uid,
      distanceMetres: round6(placement.courseProjection.measuredLayout.distance),
      arc: round6(placement.courseProjection.measuredLayout.arc),
      source: 'recovered',
    }));
}

// ---------------------------------------------------------------------------
// One simulation: one wasm instance + one AI driver + one policy.
// ---------------------------------------------------------------------------

function normalizeEvent(event) {
  return {
    ...event,
    tick: Number.isInteger(event.tick) ? event.tick : Math.round((event.at ?? 0) * 60),
  };
}

function positionOf(value) {
  return { x: value?.position?.x ?? value?.x ?? 0, z: value?.position?.z ?? value?.z ?? 0 };
}

function distance2d(a, b) {
  const pa = positionOf(a);
  const pb = positionOf(b);
  return Math.hypot(pa.x - pb.x, pa.z - pb.z);
}

async function createSim({ factory, levelBytes, fieldBytes, layout, profileId, car,
  policyCapabilities = null, controlOverrides = null }) {
  const module = await factory();
  const world = createEngineWorld(module, levelBytes, fieldBytes);
  const start = layoutStart(layout);
  world.createAt(start.x, start.z, start.heading);
  let state = world.read();
  const driver = createAiDriver({ layout, profile: profileId, controlOverrides });
  driver.prime(state);
  const policy = createAiPowerupPolicy({
    profileId,
    capabilities: policyCapabilities ?? undefined,
  });
  return {
    car, profileId, module, world, driver, policy, state,
    start,
    hashes: [hashOf(state)],
    decisionHashes: [],
    inputs: [],
    rebuilds: [],
    events: [],
    metrics: newMetrics(),
    steps: 0,
    raceTick: 0,
    postFinish: 0,
    finishTick: null,
    status: 'running',
    progress: 0,
    worldPlayerId: `ai-${profileId}`,
    lastDecision: null,
    intentCounts: {},
    useCounts: {},
    pickupCounts: {},
    skipCounts: {},
    dropCounts: {},
    appliedIntents: [],
    violations: [],
    contentionCount: 0,
    maxUsesPerPlayerPerTick: 0,
    postFinishIntents: 0,
    postFinishUseIntents: 0,
    finish: null,
  };
}

function driverProgress(sim) {
  if (sim.finish) return 1e9 + sim.finish.tick;
  const projection = sim.driver.projection;
  if (!projection) return 0;
  const length = sim.driver.track.length;
  return sim.driver.lapsCompleted * length + projection.arc;
}

function buildSelf(sim, powerWorld) {
  const player = powerWorld.players.get(sim.worldPlayerId);
  const position = { x: sim.state.position[0], z: sim.state.position[2] };
  return {
    id: sim.worldPlayerId,
    position,
    heading: Math.atan2(sim.state.axisZ[0], sim.state.axisZ[2]),
    speed: sim.state.speed ?? 0,
    steer: sim.state.input?.[2] ?? 0,
    health: player.health,
    maxHealth: player.maxHealth,
    alive: player.alive,
    finished: sim.driver.finished,
    inventory: player.inventory.map((item) => ({ ...item })),
    inventoryCapacity: player.inventoryCapacity,
    effects: powerWorld.effects
      .filter((effect) => effect.ownerId === sim.worldPlayerId)
      .map((effect) => ({ ...effect })),
  };
}

function buildOpponents(sims, selfSim, powerWorld) {
  const rows = sims.filter((sim) => sim !== selfSim).map((sim) => ({
    id: sim.worldPlayerId,
    position: { x: sim.state.position[0], z: sim.state.position[2] },
    heading: Math.atan2(sim.state.axisZ[0], sim.state.axisZ[2]),
    speed: sim.state.speed ?? 0,
    alive: powerWorld.players.get(sim.worldPlayerId).alive,
    progress: sim.progress,
  }));
  rows.sort((a, b) => b.progress - a.progress);
  rows.forEach((row, index) => { row.racePosition = index + 1; });
  return rows;
}

function recordDecisionCounts(sim, decision) {
  sim.lastDecision = decision;
  sim.decisionHashes.push(decision.hash);
  for (const intent of decision.intents) {
    const key = intent.pickupType;
    sim.intentCounts[key] = (sim.intentCounts[key] ?? 0) + 1;
  }
  for (const diagnostic of decision.diagnostics) {
    const key = diagnostic.pickupType ?? 'unknown';
    sim.skipCounts[key] = (sim.skipCounts[key] ?? 0) + 1;
  }
}

function applyIntent(sim, intent, powerWorld) {
  const player = powerWorld.players.get(sim.worldPlayerId);
  const playerPosition = { x: sim.state.position[0], z: sim.state.position[2] };
  if (intent.kind === 'pickup') {
    const pickup = powerWorld.pickups.get(intent.pickupId);
    if (!pickup || pickup.state !== 'active') {
      return { applied: false, reason: 'pickup-not-active', contention: true };
    }
    if (distance2d(pickup.position, playerPosition) > PICKUP_RADIUS + 1e-9) {
      return { applied: false, reason: 'pickup-out-of-radius' };
    }
    if (player.inventory.length >= player.inventoryCapacity) {
      return { applied: false, reason: 'inventory-full' };
    }
    const before = powerWorld.events.length;
    powerWorld.pickup(pickup.id, sim.worldPlayerId);
    const events = powerWorld.events.slice(before);
    const rejected = events.find((event) => event.type === 'pickup-rejected');
    return rejected
      ? { applied: false, reason: rejected.reason ?? 'pickup-rejected',
        contention: rejected.reason === 'not-active', events }
      : { applied: true, events };
  }
  if (intent.kind === 'use') {
    if (!player.alive) return { applied: false, reason: 'wrecked' };
    if (sim.driver.finished) return { applied: false, reason: 'finished' };
    const slot = intent.slot ?? 0;
    const item = player.inventory[slot];
    if (!item) return { applied: false, reason: 'empty-slot' };
    if (item.type !== intent.pickupType) {
      return { applied: false, reason: 'slot-type-mismatch' };
    }
    const before = powerWorld.events.length;
    powerWorld.use(sim.worldPlayerId, {
      slot,
      targetId: intent.targetId ?? undefined,
      position: intent.position ?? undefined,
      checkpoint: intent.checkpoint ?? undefined,
    });
    const events = powerWorld.events.slice(before);
    const rejected = events.find((event) => event.type === 'use-rejected');
    return rejected
      ? { applied: false, reason: rejected.reason ?? 'use-rejected', events }
      : { applied: true, events };
  }
  if (intent.kind === 'drop') {
    const slot = intent.slot ?? 0;
    const item = player.inventory[slot];
    if (!item) return { applied: false, reason: 'empty-slot' };
    player.inventory.splice(slot, 1);
    const event = powerWorld.emit('pickup-dropped', {
      playerId: sim.worldPlayerId, pickupType: item.type, slot,
      reason: intent.reason, source: 'ai-contract-extension',
    });
    return { applied: true, events: [event] };
  }
  return { applied: false, reason: 'unknown-intent' };
}

function addRecent(recent, events, tick, horizonTicks = 180) {
  for (const event of events) {
    recent.push({ ...normalizeEvent(event), tick });
  }
  const cutoff = tick - horizonTicks;
  while (recent.length && recent[0].tick < cutoff) recent.shift();
}

function worldEventHash(events) {
  return aggregateHash(events.map((event) => hashOf(event)));
}

// ---------------------------------------------------------------------------
// Scenario runs.
// ---------------------------------------------------------------------------

async function runScenario({ factory, levelBytes, fieldBytes, layout, car, scenario,
  profileIds, kind, policyCapabilitiesByProfile = {}, controlOverrides = null }) {
  const powerWorld = createWorld(readJson(POWERUPS_MANIFEST), {
    authorityId: 'host-ai',
    mode: 'Normal',
    normalRespawnSeconds: null,
  });
  const countdownTicks = layout.countdown?.ticks ?? 0;
  const sims = [];
  for (const profileId of profileIds) {
    const sim = await createSim({
      factory, levelBytes, fieldBytes, layout, profileId, car,
      policyCapabilities: policyCapabilitiesByProfile[profileId] ?? null,
      controlOverrides,
    });
    powerWorld.addPlayer(sim.worldPlayerId, {
      health: 100, maxHealth: 100, inventoryCapacity: INVENTORY_CAPACITY,
      position: { x: sim.start.x, z: sim.start.z },
    });
    sims.push(sim);
  }

  // Spawn the scenario pickups in a deterministic order.
  const driverForSlots = createAiDriver({ layout, profile: 'reference' });
  const slots = scenario.mode === 'recovered'
    ? scenario.slots
    : provisionalSlots(driverForSlots, scenario);
  const spawnedPickups = [];
  for (const slot of slots) {
    const pickup = powerWorld.spawnPickup(slot.type, { x: slot.position.x, z: slot.position.z });
    spawnedPickups.push({
      id: pickup.id, type: pickup.type, position: pickup.position,
      state: pickup.state, source: slot.source,
      arc: slot.arc ?? null, uid: slot.uid ?? null,
      distanceMetres: slot.distanceMetres ?? null,
    });
  }

  for (let tick = 0; tick < countdownTicks; tick++) {
    for (const sim of sims) {
      sim.world.setInput([0, 0, 0, 0]);
      sim.world.step();
      sim.state = sim.world.read();
      sim.steps += 1;
      sim.inputs.push([0, 0, 0, 0]);
      sim.hashes.push(hashOf(sim.state));
    }
  }

  const maxRaceTicks = MAX_RACE_TICKS[layout.courseId] ?? 7200;
  const recentEvents = [];
  let raceTick = 0;
  let done = false;
  while (!done) {
    raceTick += 1;
    if (raceTick > maxRaceTicks) break;

    // 1. Physics for every car.
    for (const sim of sims) {
      const terms = sim.driver.step(sim.state);
      sim.world.setInput(terms.input);
      sim.world.step();
      sim.state = sim.world.read();
      sim.steps += 1;
      sim.inputs.push(terms.input);
      sim.hashes.push(hashOf(sim.state));
      const events = sim.driver.observe(sim.state, raceTick);
      mergeMetrics(sim.metrics, sim.state, sim.driver.projection, !sim.driver.finished);
      const respawn = events.find((event) => event.type === 'respawn');
      if (respawn) {
        sim.metrics.respawns += 1;
        sim.world.createAt(respawn.target.x, respawn.target.z, respawn.target.headingRad);
        sim.state = sim.world.read();
        sim.driver.reprime(sim.state);
        sim.rebuilds.push({ afterStep: sim.steps, tick: raceTick, reason: respawn.reasons });
      }
      if (sim.driver.finished && sim.finishTick === null) {
        sim.finishTick = sim.driver.finish.tick;
        sim.finish = sim.driver.finish;
        sim.status = 'finished';
      }
      sim.progress = driverProgress(sim);
      const player = powerWorld.players.get(sim.worldPlayerId);
      player.position = { x: sim.state.position[0], z: sim.state.position[2] };
    }

    // 2. World tick (respawn timers, mines, effects).
    const beforeAdvance = powerWorld.events.length;
    powerWorld.advance(1 / 60);
    const advanceEvents = powerWorld.events.slice(beforeAdvance);
    addRecent(recentEvents, advanceEvents, raceTick);

    // 3. Policy decisions. The host applies the intents.
    const decisions = [];
    for (const sim of sims) {
      const self = buildSelf(sim, powerWorld);
      const decision = sim.policy.decide({
        tick: raceTick,
        self,
        opponents: buildOpponents(sims, sim, powerWorld),
        pickups: [...powerWorld.pickups.values()].map((pickup) => ({ ...pickup })),
        mines: powerWorld.mines.map((mine) => ({ ...mine })),
        effects: powerWorld.effects.map((effect) => ({ ...effect })),
        events: recentEvents.slice(),
        finished: sim.driver.finished,
      });
      recordDecisionCounts(sim, decision);
      decisions.push({ sim, decision });
      const useIntentCount = decision.intents.filter((intent) => intent.kind === 'use').length;
      if (useIntentCount > 1) {
        sim.violations.push({ tick: raceTick, reason: 'double-use-intent',
          count: useIntentCount });
      }
      if (sim.driver.finished && decision.intents.length > 0) {
        sim.postFinishIntents += decision.intents.length;
        sim.postFinishUseIntents += useIntentCount;
      }
    }

    // Deterministic host arbitration: the leading car reaches a contested
    // pickup first, so apply intents in descending progress order rather than
    // in roster order. This is a host rule, not a physics claim.
    decisions.sort((a, b) => {
      if (b.sim.progress !== a.sim.progress) return b.sim.progress - a.sim.progress;
      return a.sim.profileId < b.sim.profileId ? -1 : 1;
    });
    const beforeIntents = powerWorld.events.length;
    for (const { sim, decision } of decisions) {
      for (const intent of decision.intents) {
        const outcome = applyIntent(sim, intent, powerWorld);
        if (!outcome.applied) {
          if (outcome.contention) {
            sim.contentionCount += 1;
          } else {
            sim.violations.push({ tick: raceTick, intent, reason: outcome.reason });
          }
          continue;
        }
        sim.appliedIntents.push({ tick: raceTick, intent });
        if (intent.kind === 'pickup') {
          sim.pickupCounts[intent.pickupType] = (sim.pickupCounts[intent.pickupType] ?? 0) + 1;
        }
        if (intent.kind === 'drop') {
          sim.dropCounts[intent.pickupType] = (sim.dropCounts[intent.pickupType] ?? 0) + 1;
        }
        let useEventsThisTick = 0;
        for (const event of outcome.events) {
          if (event.type && /-(activated|placed|fired|gained|repaired)$/.test(event.type)) {
            const type = event.pickupType ?? intent.pickupType;
            sim.useCounts[type] = (sim.useCounts[type] ?? 0) + 1;
            useEventsThisTick += 1;
          }
        }
        if (useEventsThisTick > 1) {
          sim.violations.push({ tick: raceTick, reason: 'double-fire',
            count: useEventsThisTick });
        }
        sim.maxUsesPerPlayerPerTick = Math.max(sim.maxUsesPerPlayerPerTick,
          useEventsThisTick);
        sim.events.push(...outcome.events.map(normalizeEvent));
      }
    }
    addRecent(recentEvents, powerWorld.events.slice(beforeIntents), raceTick);

    // 4. Post-finish bookkeeping.
    for (const sim of sims) {
      if (!sim.driver.finished) continue;
      if (sim.postFinish < POST_FINISH_TICKS) sim.postFinish += 1;
    }
    done = sims.every((sim) => sim.driver.finished && sim.postFinish >= POST_FINISH_TICKS);
  }

  // A DNF run still records its partial state; the verifier fails it.
  for (const sim of sims) {
    if (!sim.driver.finished) sim.status = 'dnf';
  }

  const worldEvents = powerWorld.events.slice();
  const invalidWorldEvents = worldEvents.filter((event) =>
    !Number.isInteger(event.seq) || typeof event.type !== 'string' ||
    !Number.isFinite(event.at) || typeof event.authority !== 'string').length;
  const seqMonotonic = worldEvents.every((event, index) =>
    index === 0 || event.seq === worldEvents[index - 1].seq + 1);
  const rows = sims.map((sim) => ({
    car: sim.car.slug,
    carName: sim.car.name,
    profile: sim.profileId,
    difficulty: sim.policy.difficulty,
    setupRecord: sim.policy.controller.setupRecord,
    status: sim.status,
    finishTick: sim.finishTick,
    timeSeconds: sim.finish?.timeSeconds ?? null,
    lapTimes: sim.driver.lapTimes.slice(),
    respawns: sim.metrics.respawns,
    nanTicks: sim.metrics.nanTicks,
    maxLateralMetres: round6(sim.metrics.maxLateralMetres),
    stateSequenceHash: aggregateHash(sim.hashes),
    decisionAggregateHash: aggregateHash(sim.decisionHashes),
    inputHash: hashOf(sim.inputs),
    eventAggregateHash: worldEventHash(sim.events),
    intentCounts: sim.intentCounts,
    useCounts: sim.useCounts,
    pickupCounts: sim.pickupCounts,
    skipCounts: sim.skipCounts,
    dropCounts: sim.dropCounts,
    appliedIntentCount: sim.appliedIntents.length,
    contentionCount: sim.contentionCount,
    maxUsesPerPlayerPerTick: sim.maxUsesPerPlayerPerTick,
    violations: sim.violations,
    postFinishIntents: sim.postFinishIntents,
    postFinishUseIntents: sim.postFinishUseIntents,
    supportedTypes: sim.policy.supported,
    policy: sim.policy.snapshot(),
  }));
  rows.sort((a, b) => {
    if (a.finishTick === null && b.finishTick === null) return a.profile < b.profile ? -1 : 1;
    if (a.finishTick === null) return 1;
    if (b.finishTick === null) return -1;
    return a.finishTick - b.finishTick;
  });
  rows.forEach((row, index) => { row.position = index + 1; });

  const decisionAggregate = aggregateHash(rows.map((row) => row.decisionAggregateHash));
  const eventAggregate = worldEventHash(worldEvents);
  const runHash = hashOf({
    scenario: scenario.id, course: layout.courseId, kind,
    profiles: rows.map((row) => row.profile),
    rows: rows.map((row) => ({
      profile: row.profile, finishTick: row.finishTick,
      stateSequenceHash: row.stateSequenceHash,
      decisionAggregateHash: row.decisionAggregateHash,
      useCounts: row.useCounts, pickupCounts: row.pickupCounts,
    })),
    decisionAggregate, eventAggregate,
  });

  return {
    scenario: scenario.id,
    scenarioSource: scenario.source,
    scenarioStatus: scenario.status,
    courseId: layout.courseId,
    kind,
    car: car.slug,
    spawnedPickups,
    rows,
    raceTicks: raceTick,
    decisionAggregate,
    eventAggregate,
    worldEventCount: worldEvents.length,
    worldEventValidity: {
      count: worldEvents.length,
      invalid: invalidWorldEvents,
      seqMonotonic,
      authority: 'host-ai',
    },
    runHash,
  };
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

mkdirSync(OUT, { recursive: true });

const build = readJson(BUILD);
const roster = readJson(CARS).roster;
const sprintLayout = readJson(SPRINT_LAYOUT);
const lapLayout = readJson(LAP_LAYOUT);
const powerupsManifest = readJson(POWERUPS_MANIFEST);
const placements = readJson(PLACEMENTS);
const recoveredAi = readJson(RECOVERED_AI);
const car = roster.cars.find((entry) => entry.slug === CARS_FOR_POLICY);
if (!car) throw new Error(`roster car not found: ${CARS_FOR_POLICY}`);
const fieldBytes = readFileSync(path.join(ROOT, car.fields.path));
const fieldHash = sha256Hex(fieldBytes);
if (fieldHash !== car.fields.sha256) {
  throw new Error(`fields hash mismatch for ${car.slug}`);
}

const courseDefinitions = {
  '310m': { layout: sprintLayout, levelBytes: readFileSync(LEVEL) },
  lap: { layout: lapLayout, levelBytes: readFileSync(LEVEL) },
};
if (args.includes('--amboy')) {
  courseDefinitions.amboy = {
    layout: readJson(AMBOY_LAYOUT),
    levelBytes: readFileSync(AMBOY_LEVEL),
    controlOverrides: { minSpeed: 3.5 },
  };
}

const scenariosByCourse = {
  '310m': [
    { ...PROVISIONAL_310_PWR2, mode: 'provisional' },
    { ...PROVISIONAL_310_8TYPE, mode: 'provisional' },
  ],
  lap: [
    {
      id: 'recovered-loop01', mode: 'recovered', status: 'recovered',
      source: 'PWR3 recovered PickupPosition placements within 2.0 m of loop-01',
      slots: recoveredSlots(placements, 'loop01'),
    },
    { ...PROVISIONAL_LOOP_8TYPE, mode: 'provisional' },
  ],
  amboy: [
    {
      id: 'recovered-amboy', mode: 'recovered', status: 'recovered',
      source: 'PWR3 recovered PickupPosition placements within 2.0 m of the measured Amboy path',
      slots: amboyRecoveredSlots(readJson(AMBOY_PLACEMENTS)),
    },
    { ...PROVISIONAL_AMBOY_8TYPE, mode: 'provisional' },
  ],
};

const factory = await (await import(pathToFileURL(MODULE).href)).default;
const scenarioResults = [];
const profileIds = ONLY_PROFILES ?? ['cautious', 'standard', 'reference'];

for (const [courseId, definition] of Object.entries(courseDefinitions)) {
  for (const scenario of scenariosByCourse[courseId] ?? []) {
    if (ONLY_SCENARIOS && !ONLY_SCENARIOS.includes(scenario.id)) continue;
    process.stdout.write(`[ai-powerups] scenario ${courseId}/${scenario.id} (${scenario.slots?.length ?? scenario.arcs.length} pickups)\n`);
    // Solo runs: one AI per profile, no pickup contention.
    for (const profileId of profileIds) {
      const result = await runScenario({
        factory, levelBytes: definition.levelBytes, fieldBytes,
        layout: definition.layout, car, scenario, profileIds: [profileId],
        kind: 'solo', controlOverrides: definition.controlOverrides ?? null,
      });
      scenarioResults.push(result);
      const row = result.rows[0];
      process.stdout.write(`[ai-powerups]   solo ${profileId} ${row.status} t=${row.timeSeconds} ` +
        `uses=${JSON.stringify(row.useCounts)} pickups=${JSON.stringify(row.pickupCounts)} ` +
        `violations=${row.violations.length} hash=${result.runHash.slice(0, 19)}\n`);
    }
    // Three-profile race: shared pickup world, independent wasm per AI.
    const race = await runScenario({
      factory, levelBytes: definition.levelBytes, fieldBytes,
      layout: definition.layout, car, scenario, profileIds,
      kind: 'race', controlOverrides: definition.controlOverrides ?? null,
    });
    scenarioResults.push(race);
    process.stdout.write(`[ai-powerups]   race ${race.rows.map((row) => `${row.position}.${row.profile}(${row.timeSeconds ?? 'DNF'})`).join(' ')} ` +
      `hash=${race.runHash.slice(0, 19)}\n`);
  }
}

// Graceful-degradation run: two weapon types are declared unsupported. The AI
// must skip them with a typed reason and never emit a placeholder fire.
const degradedScenario = {
  id: 'degraded-unsupported-shock-bomb',
  source: 'degradation proof: Shock and Bomb removed from the capability set; a supported Shield remains',
  status: 'provisional',
  mode: 'provisional',
  arcs: [40, 90, 140],
  types: ['Shock', 'Shield', 'Bomb'],
};
const degradedProfiles = ['reference'];
const degraded = await runScenario({
  factory, levelBytes: courseDefinitions['310m'].levelBytes, fieldBytes,
  layout: sprintLayout, car, scenario: degradedScenario, profileIds: degradedProfiles,
  kind: 'degraded',
  policyCapabilitiesByProfile: {
    reference: {
      types: SUPPORTED_MP_TYPES.filter((type) => type !== 'Shock' && type !== 'Bomb'),
    },
  },
});
scenarioResults.push(degraded);
process.stdout.write(`[ai-powerups] degraded ${degraded.rows[0].status} ` +
  `skips=${JSON.stringify(degraded.rows[0].skipCounts)} uses=${JSON.stringify(degraded.rows[0].useCounts)}\n`);

// Per-profile usage summary over the solo runs only (no contention) plus races.
const usageByProfile = {};
for (const profileId of ['cautious', 'standard', 'reference']) {
  const solos = scenarioResults.filter((result) => result.kind === 'solo' &&
    result.rows.some((row) => row.profile === profileId));
  const rows = solos.map((result) => result.rows.find((row) => row.profile === profileId));
  const totals = {};
  let races = 0;
  for (const row of rows) {
    races += 1;
    for (const [type, count] of Object.entries(row.useCounts)) {
      totals[type] = (totals[type] ?? 0) + count;
    }
  }
  usageByProfile[profileId] = {
    difficulty: AI_PROFILE_DIFFICULTY[profileId],
    soloRuns: races,
    usesByType: totals,
    totalUses: Object.values(totals).reduce((sum, value) => sum + value, 0),
    meanUsesPerSoloRun: races
      ? round6(Object.values(totals).reduce((sum, value) => sum + value, 0) / races)
      : 0,
    soloScenarios: solos.map((result) => ({
      scenario: result.scenario, courseId: result.courseId,
      useCounts: result.rows.find((row) => row.profile === profileId).useCounts,
      pickupCounts: result.rows.find((row) => row.profile === profileId).pickupCounts,
      dropCounts: result.rows.find((row) => row.profile === profileId).dropCounts,
      finishTick: result.rows.find((row) => row.profile === profileId).finishTick,
    })),
  };
}

const results = {
  kind: 'blur.ai-powerups-results',
  version: 1,
  policy: {
    kind: AI_POWERUP_POLICY_KIND,
    version: AI_POWERUP_POLICY_VERSION,
    supportedTypes: SUPPORTED_MP_TYPES,
    profileDifficulty: AI_PROFILE_DIFFICULTY,
    recoveredController: RECOVERED_AI_CONTROLLER,
    recoveredTriggers: RECOVERED_AI_TRIGGERS,
  },
  inputs: {
    module: { path: path.relative(ROOT, MODULE).split(path.sep).join('/'),
      wasmSha256: build.wasmSha256, wasmBytes: build.wasmBytes },
    level: { path: path.relative(ROOT, LEVEL).split(path.sep).join('/'),
      bytes: courseDefinitions['310m'].levelBytes.length,
      sha256: sha256Hex(courseDefinitions['310m'].levelBytes) },
    powerupsManifest: { path: path.relative(ROOT, POWERUPS_MANIFEST).split(path.sep).join('/'),
      sha256: sha256Hex(readFileSync(POWERUPS_MANIFEST)) },
    placements: { path: path.relative(ROOT, PLACEMENTS).split(path.sep).join('/'),
      sha256: sha256Hex(readFileSync(PLACEMENTS)) },
    recoveredAi: { path: path.relative(ROOT, RECOVERED_AI).split(path.sep).join('/'),
      sha256: sha256Hex(readFileSync(RECOVERED_AI)) },
    car: { slug: car.slug, name: car.name, fieldsSha256: car.fields.sha256 },
    layouts: Object.fromEntries(Object.entries(courseDefinitions).map(([id, definition]) => [
      id, { summary: layoutSummary(definition.layout),
        fileSha256: sha256Hex(readFileSync(id === 'amboy' ? AMBOY_LAYOUT
          : id === 'lap' ? LAP_LAYOUT : SPRINT_LAYOUT)) },
    ])),
    recoveredAiCrossCheck: {
      controllerRows: recoveredAi.pickupsAi.controller['355'].difficultyRows.length,
      setupRecords: Object.keys(recoveredAi.pickupsAi.setupRecords).map(Number).sort((a, b) => a - b),
      aiPerkUseEntries: recoveredAi.singlePlayer.aiPerkUseEntries,
      difficultyPerkRecords: recoveredAi.singlePlayer.difficultyPerks.recordCount,
    },
  },
  config: {
    postFinishTicks: POST_FINISH_TICKS,
    maxRaceTicks: MAX_RACE_TICKS,
    pickupRadius: PICKUP_RADIUS,
    inventoryCapacity: INVENTORY_CAPACITY,
    inventoryCapacityStatus: 'runtime-only in the retail data; 2 is a host config',
    authority: 'host-ai',
    projectileHitResolution: 'not-resolved (fire intent/event only)',
    scenarios: Object.fromEntries(Object.entries(scenariosByCourse).map(([courseId, scenarios]) => [
      courseId, scenarios.map((scenario) => ({ id: scenario.id, status: scenario.status,
        source: scenario.source, pickups: scenario.slots?.length ?? scenario.arcs.length })),
    ])),
  },
  runs: scenarioResults,
  usageByProfile,
  determinism: {
    runHashes: scenarioResults.map((result) => ({ scenario: result.scenario,
      courseId: result.courseId, kind: result.kind, runHash: result.runHash })),
    decisionAggregate: aggregateHash(scenarioResults.map((result) => result.decisionAggregate)),
    eventAggregate: aggregateHash(scenarioResults.map((result) => result.eventAggregate)),
  },
};

writeFileSync(path.join(OUT, 'results-powerups.json'),
  JSON.stringify(results, null, 2) + '\n');
process.stdout.write(`[ai-powerups] wrote _work/ai-driver/results-powerups.json ` +
  `(${scenarioResults.length} scenario runs)\n`);
