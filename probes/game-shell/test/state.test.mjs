import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_MAX,
  CAR_CLASSES,
  ERROR,
  MODE_ORDER,
  SCREENS,
  TRANSITIONS,
  canTransition,
  configSignature,
  createShellState,
  engineQueryFor,
  filterCars,
  formatMetres,
  gamepadIntent,
  mapSupportsMode,
  measuredLength,
  nextGridIndex,
  normalizeCars,
  normalizeRoomCode,
  reduce,
  routeForScreen,
  startRejection,
  toQuery,
  unsupportedReason
} from '../shell-state.js';
import { dataset, makeState, walkTo } from './fixtures.mjs';

const data = dataset();

test('roster normalisation covers all 61 cars with real fields and data classes', () => {
  const cars = normalizeCars(data.roster, data.classes.classes);
  assert.equal(cars.length, 61);
  assert.equal(new Set(cars.map((car) => car.slug)).size, 61);
  const counts = { A: 0, B: 0, C: 0, unclassified: 0 };
  for (const car of cars) {
    assert.ok(CAR_CLASSES.includes(car.carClass), car.slug + ' class');
    counts[car.carClass] += 1;
    assert.ok(['RWD', 'FWD', 'AWD'].includes(car.drivetrain), car.slug + ' drivetrain');
    assert.ok(Number.isFinite(car.massKg) && car.massKg > 0, car.slug + ' mass');
    assert.match(car.gearbox, /^\d+-speed$/, car.slug + ' gearbox');
    assert.equal(car.icon, 'not-decoded');
    assert.equal(car.layoutParsed, true, car.slug + ' layout');
  }
  assert.deepEqual(counts, { A: 5, B: 42, C: 14, unclassified: 0 });
  assert.deepEqual(data.classes.counts, counts);
});

test('the generated cars.json record shape is normalised without losing identity', () => {
  const cars = normalizeCars({
    roster: {
      cars: [{
        slug: 'corvette-zr1-stock',
        name: 'Corvette_ZR1_Stock',
        order: 0,
        record: { index: 37, id: 1554942492, name: 'Corvette_ZR1_Stock' },
        layout: 'RWD, 1600 kg, 6-speed'
      }]
    }
  }, { 'corvette-zr1-stock': 'A' });
  assert.equal(cars.length, 1);
  assert.equal(cars[0].recordIndex, 37);
  assert.equal(cars[0].recordId, 1554942492);
  assert.equal(cars[0].carClass, 'A');
  assert.equal(cars[0].drivetrain, 'RWD');
});

test('map registry binds every registered map and its real course support', () => {
  const state = makeState();
  assert.equal(state.maps.length, 13);
  assert.deepEqual(state.maps.map((map) => map.id),
    ['river', 'amboy', 'gracia', 'longbeach', 'observatory', 'downtown', 'mharuna',
      'highrise', 'shutoko', 'oval', 'amboy-mp', 'dumbo', 'downtown-mp']);
  const river = state.maps.find((map) => map.id === 'river');
  const amboy = state.maps.find((map) => map.id === 'amboy');
  const gracia = state.maps.find((map) => map.id === 'gracia');
  const longbeach = state.maps.find((map) => map.id === 'longbeach');
  const observatory = state.maps.find((map) => map.id === 'observatory');
  const downtown = state.maps.find((map) => map.id === 'downtown');
  const mharuna = state.maps.find((map) => map.id === 'mharuna');
  const highrise = state.maps.find((map) => map.id === 'highrise');
  const shutoko = state.maps.find((map) => map.id === 'shutoko');
  const oval = state.maps.find((map) => map.id === 'oval');
  const amboyMp = state.maps.find((map) => map.id === 'amboy-mp');
  const dumbo = state.maps.find((map) => map.id === 'dumbo');
  const downtownMp = state.maps.find((map) => map.id === 'downtown-mp');
  assert.deepEqual(river.courses, ['310', 'short', 'lap', 'free']);
  assert.deepEqual(amboy.courses, ['310', 'lap']);
  assert.deepEqual(gracia.courses, ['310']);
  for (const mode of MODE_ORDER) assert.equal(mapSupportsMode(river, mode), true, 'river ' + mode);
  assert.equal(mapSupportsMode(amboy, 'sprint'), true);
  assert.equal(mapSupportsMode(amboy, 'multiplayer'), true);
  assert.equal(mapSupportsMode(amboy, 'lap'), true);
  assert.equal(mapSupportsMode(amboy, 'free'), false);
  assert.equal(mapSupportsMode(gracia, 'lap'), false);
  assert.equal(measuredLength(river, 'sprint').text, '310.395 m');
  assert.equal(measuredLength(river, 'lap').text, '222.040 m');
  assert.equal(measuredLength(amboy, 'sprint').text, '2,060.595 m');
  assert.equal(measuredLength(amboy, 'lap').text, '284.452 m');
  assert.equal(measuredLength(gracia, 'sprint').text, '624.914 m');
  assert.equal(measuredLength(longbeach, 'sprint').text, '785.823 m');
  assert.equal(measuredLength(observatory, 'sprint').text, '536.622 m');
  assert.equal(measuredLength(downtown, 'sprint').text, '153.861 m');
  assert.equal(measuredLength(mharuna, 'sprint').text, '309.170 m');
  assert.equal(measuredLength(highrise, 'sprint').text, '14.269 m');
  assert.equal(measuredLength(shutoko, 'sprint').text, '279.005 m');
  assert.equal(measuredLength(oval, 'sprint').text, '753.021 m');
  assert.equal(measuredLength(amboyMp, 'sprint').text, '122.294 m');
  assert.equal(measuredLength(dumbo, 'sprint').text, '361.999 m');
  assert.equal(measuredLength(downtownMp, 'sprint').text, '86.453 m');
  assert.equal(measuredLength(river, 'free').text, '7,702.25 m2 basin');
  for (const map of [longbeach, observatory, downtown, mharuna, highrise, shutoko, oval, amboyMp, dumbo, downtownMp]) {
    assert.equal(mapSupportsMode(map, 'sprint'), true, map.id);
    assert.equal(mapSupportsMode(map, 'multiplayer'), true, map.id);
    assert.equal(mapSupportsMode(map, 'lap'), false, map.id);
  }
});

test('unsupported map/mode pairs produce the visible reason instead of switching', () => {
  const state = makeState({ screen: 'map-select', mode: 'lap', carSlug: 'corvette-zr1-stock', mapId: 'river' });
  const after = reduce(state, { type: 'map/select', mapId: 'gracia' });
  assert.equal(after.screen, 'map-select');
  assert.equal(after.mapId, 'river');
  assert.equal(after.notice.code, ERROR.UNSUPPORTED_COMBINATION);
  assert.match(after.notice.message, /Gracia lists courses \[310\]/);
  assert.match(after.notice.message, /no 3-lap loop layout/);
  const reason = unsupportedReason(state.maps.find((map) => map.id === 'amboy'), 'free');
  assert.match(reason, /Amboy lists courses \[310, lap\]/);
  assert.match(reason, /no free roam layout/);
  assert.equal(unsupportedReason(state.maps.find((map) => map.id === 'river'), 'lap'), null);
  assert.equal(unsupportedReason(state.maps.find((map) => map.id === 'amboy'), 'lap'), null);
});

test('every legal screen edge exists and illegal edges are rejected', () => {
  for (const screen of SCREENS) {
    for (const target of TRANSITIONS[screen]) assert.equal(canTransition(screen, target), true);
  }
  assert.equal(canTransition('main-menu', 'race'), false);
  assert.equal(canTransition('race', 'lobby'), false);
  assert.equal(canTransition('results', 'car-select'), false);
});

test('solo sprint path reaches every screen and rematches without a reload', () => {
  let state = makeState();
  state = reduce(state, { type: 'menu/play' });
  assert.equal(state.screen, 'mode-select');
  state = reduce(state, { type: 'mode/select', mode: 'sprint' });
  assert.equal(state.screen, 'car-select');
  state = reduce(state, { type: 'car/select', slug: 'lotus-exige-cup260-stock' });
  state = reduce(state, { type: 'car/confirm' });
  assert.equal(state.screen, 'map-select');
  state = reduce(state, { type: 'map/select', mapId: 'amboy' });
  const gate = startRejection(state);
  assert.equal(gate.ok, true);
  assert.equal(gate.config.course, '310');
  state = reduce(state, { type: 'start', now: 1000 });
  assert.equal(state.screen, 'loading');
  assert.equal(state.loading.status, 'loading');
  state = reduce(state, { type: 'loading/ready', now: 1100 });
  assert.equal(state.screen, 'race');
  state = reduce(state, {
    type: 'race/finish',
    now: 1200,
    result: {
      positions: [{ position: 1, name: 'You', car: 'lotus-exige-cup260-stock', timeSeconds: 92.4, laps: 1 }],
      mode: 'sprint',
      mapId: 'amboy',
      course: '310'
    }
  });
  assert.equal(state.screen, 'results');
  assert.equal(state.results.positions.length, 1);
  state = reduce(state, { type: 'results/rematch', now: 1300 });
  assert.equal(state.screen, 'loading');
  assert.equal(state.loading.attempt, 2);
  state = reduce(state, { type: 'loading/ready', now: 1400 });
  assert.equal(state.screen, 'race');
  state = reduce(state, { type: 'race/quit' });
  assert.equal(state.screen, 'main-menu');
});

test('lap starts on River and Amboy; free roam stays River-only', () => {
  for (const mapId of ['river', 'amboy']) {
    const state = makeState({ screen: 'map-select', mode: 'lap', carSlug: 'corvette-zr1-stock', mapId });
    assert.equal(startRejection(state).ok, true, 'lap ' + mapId);
  }
  const blockedLap = makeState({ screen: 'map-select', mode: 'lap', carSlug: 'corvette-zr1-stock', mapId: 'gracia' });
  const lapGate = startRejection(blockedLap);
  assert.equal(lapGate.ok, false);
  assert.equal(lapGate.code, ERROR.UNSUPPORTED_COMBINATION);
  assert.match(lapGate.reason, /no 3-lap loop layout/);

  const free = makeState({ screen: 'map-select', mode: 'free', carSlug: 'corvette-zr1-stock', mapId: 'river' });
  assert.equal(startRejection(free).ok, true, 'free river');
  const blockedFree = makeState({ screen: 'map-select', mode: 'free', carSlug: 'corvette-zr1-stock', mapId: 'amboy' });
  const freeGate = startRejection(blockedFree);
  assert.equal(freeGate.ok, false);
  assert.equal(freeGate.code, ERROR.UNSUPPORTED_COMBINATION);
  assert.match(freeGate.reason, /no free roam layout/);
});

test('back navigation follows the documented targets', () => {
  const cases = [
    [{ screen: 'mode-select' }, 'main-menu'],
    [{ screen: 'car-select', mode: 'sprint' }, 'mode-select'],
    [{ screen: 'map-select', mode: 'sprint' }, 'car-select'],
    [{ screen: 'lobby', mode: 'multiplayer' }, 'map-select'],
    [{ screen: 'loading', mode: 'sprint' }, 'map-select'],
    [{ screen: 'loading', mode: 'multiplayer' }, 'lobby'],
    [{ screen: 'race', mode: 'sprint' }, 'main-menu'],
    [{ screen: 'results', mode: 'sprint' }, 'main-menu']
  ];
  for (const [initial, target] of cases) {
    const state = makeState(initial);
    const after = reduce(state, { type: 'back' });
    assert.equal(after.screen, target, initial.screen);
  }
});

test('filters and sorting are deterministic and cover the whole roster', () => {
  const state = makeState({ screen: 'car-select', mode: 'sprint' });
  assert.equal(filterCars(state.cars, state.filters).length, 61);
  assert.equal(filterCars(state.cars, { query: 'corvette' }).length, 4);
  assert.equal(filterCars(state.cars, { carClass: 'A' }).length, 5);
  assert.equal(filterCars(state.cars, { carClass: 'B' }).length, 42);
  assert.equal(filterCars(state.cars, { carClass: 'C' }).length, 14);
  assert.equal(filterCars(state.cars, { carClass: 'unclassified' }).length, 0);
  assert.equal(filterCars(state.cars, { drivetrain: 'AWD' }).length, 15);
  assert.equal(filterCars(state.cars, { drivetrain: 'FWD' }).length, 4);
  assert.equal(filterCars(state.cars, { drivetrain: 'RWD' }).length, 42);
  const byMass = filterCars(state.cars, { sort: 'mass' });
  assert.equal(byMass[0].slug, 'volkswagen-beetle-offroad');
  assert.equal(byMass[0].massKg, 660);
  const byClass = filterCars(state.cars, { sort: 'class' });
  assert.deepEqual(byClass.slice(0, 5).map((car) => car.carClass), ['A', 'A', 'A', 'A', 'A']);
  assert.deepEqual(byClass.slice(-14).map((car) => car.carClass), Array(14).fill('C'));
  const names = filterCars(state.cars, { sort: 'name' }).map((car) => car.name);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
});

test('two identical action sequences produce byte-identical state', () => {
  const run = () => {
    let state = makeState({ now: 1000 });
    state = reduce(state, { type: 'menu/play' });
    state = reduce(state, { type: 'mode/select', mode: 'lap' });
    state = reduce(state, { type: 'car/select', slug: 'bmw-m3e92-tuner' });
    state = reduce(state, { type: 'car/confirm' });
    state = reduce(state, { type: 'map/select', mapId: 'river' });
    state = reduce(state, { type: 'start', now: 1000 });
    state = reduce(state, { type: 'loading/tick', now: 1500 });
    state = reduce(state, { type: 'loading/ready', now: 1600 });
    state = reduce(state, {
      type: 'race/finish',
      result: {
        positions: [{ position: 1, name: 'You', timeSeconds: 86.1, bestLapSeconds: 28.55, laps: 3 }],
        mode: 'lap',
        mapId: 'river',
        course: 'lap'
      }
    });
    return state;
  };
  assert.equal(JSON.stringify(run()), JSON.stringify(run()));
});

test('multiplayer lobby enforces the existing start rules in order', () => {
  let state = makeState({
    screen: 'lobby',
    mode: 'multiplayer',
    carSlug: 'corvette-zr1-stock',
    mapId: 'river',
    mp: { role: 'host', roomCode: 'KRP3Q', verified: true }
  });
  let gate = startRejection(state);
  assert.equal(gate.ok, false);
  assert.equal(gate.reason, 'start needs a second player or at least one AI (host simulates the AI)');

  state = reduce(state, { type: 'mp/set-ai', count: 1, now: 1000 });
  gate = startRejection(state);
  assert.equal(gate.ok, false);
  assert.equal(gate.reason, 'start needs every connected player ready');

  state = reduce(state, { type: 'mp/set-ready', ready: true, now: 1000 });
  gate = startRejection(state);
  assert.equal(gate.ok, true);
  assert.equal(gate.config.mp.aiCount, 1);

  // A map change clears readiness, so the normal reducer reports readiness
  // first (same order as app.js). The map branch is still reachable when the
  // room reports ready=true and a later verification invalidates the map.
  const unverified = {
    ...state,
    mp: {
      ...state.mp,
      verified: false,
      players: state.mp.players.map((player) => ({ ...player, ready: true }))
    }
  };
  gate = startRejection(unverified);
  assert.equal(gate.code, ERROR.MAP_UNVERIFIED);
  assert.equal(gate.reason, 'start needs this page to verify the room map first');

  const guest = makeState({
    screen: 'lobby',
    mode: 'multiplayer',
    carSlug: 'corvette-zr1-stock',
    mapId: 'river',
    mp: { role: 'guest', roomCode: 'KRP3Q', verified: true }
  });
  assert.equal(startRejection(guest).code, ERROR.HOST_ONLY);
  assert.equal(startRejection(guest).reason, 'only the host starts the race');
});

test('Gracia refuses the Dodge AI with the exact ai-spawn-unsupported reason', () => {
  let state = makeState({
    screen: 'lobby',
    mode: 'multiplayer',
    carSlug: 'corvette-zr1-stock',
    mapId: 'gracia',
    mp: { role: 'host', roomCode: 'KRP3Q', verified: true }
  });
  state = reduce(state, { type: 'mp/set-ai', count: 1, now: 1000 });
  state = reduce(state, { type: 'mp/set-ai-car', index: 0, slug: 'dodge-challenger-stock', now: 1000 });
  state = reduce(state, { type: 'mp/set-ready', ready: true, now: 1000 });
  const gate = startRejection(state);
  assert.equal(gate.ok, false);
  assert.equal(gate.code, ERROR.AI_UNSUPPORTED);
  assert.match(gate.reason, /ai-spawn-unsupported/);
  assert.match(gate.reason, /front axle is unloaded/);
});

test('AI count, profile and room-code validators are explicit', () => {
  let state = makeState({ screen: 'lobby', mode: 'multiplayer', mapId: 'river' });
  const badCount = reduce(state, { type: 'mp/set-ai', count: AI_MAX + 1 });
  assert.equal(badCount.notice.code, ERROR.AI_COUNT);
  assert.match(badCount.notice.message, /\[0, 3\]/);
  const badProfile = reduce(state, { type: 'mp/set-ai', count: 1 });
  const wrongProfile = reduce(badProfile, { type: 'mp/set-ai-profile', index: 0, profile: 'alien' });
  assert.equal(wrongProfile.notice.code, ERROR.AI_COUNT);
  assert.match(wrongProfile.notice.message, /cautious, standard, reference/);
  assert.equal(normalizeRoomCode('KRP3Q'), 'KRP3Q');
  assert.equal(normalizeRoomCode('krp3q'), 'KRP3Q');
  assert.equal(normalizeRoomCode('ABCIO'), null); // I/O are excluded
  assert.equal(normalizeRoomCode('ABCD'), null);
});

test('loading timeout and typed failures stay on the loading screen', () => {
  let state = makeState({ screen: 'map-select', mode: 'sprint', carSlug: 'corvette-zr1-stock', mapId: 'river' });
  state = reduce(state, { type: 'start', now: 1000 });
  assert.equal(state.loading.startedAt, 1000);
  state = reduce(state, { type: 'loading/tick', now: 1500 });
  assert.equal(state.loading.error, null);
  state = reduce(state, { type: 'loading/tick', now: 2000 });
  assert.equal(state.screen, 'loading');
  assert.equal(state.loading.error.code, ERROR.LOAD_TIMEOUT);
  assert.match(state.loading.error.message, /1000 ms/);
  state = reduce(state, { type: 'loading/retry', now: 3000 });
  assert.equal(state.loading.error, null);
  assert.equal(state.loading.attempt, 2);
  state = reduce(state, { type: 'loading/fail', error: { code: 'MAP_PACKAGE_MISMATCH', message: 'hash mismatch' } });
  assert.equal(state.loading.error.code, 'MAP_PACKAGE_MISMATCH');
  assert.equal(state.loading.error.message, 'hash mismatch');
});

test('results reject invalid rows and sort valid positions', () => {
  let state = makeState({ screen: 'race', mode: 'sprint' });
  const bad = reduce(state, { type: 'race/finish', result: { positions: [] } });
  assert.equal(bad.notice.code, ERROR.RESULT_INVALID);
  assert.equal(bad.screen, 'race');
  const unsorted = reduce(state, {
    type: 'race/finish',
    result: {
      positions: [
        { position: 2, name: 'Guest', timeSeconds: 15.2 },
        { position: 1, name: 'Host', timeSeconds: 14.9, bestLapSeconds: 14.9 }
      ],
      mode: 'sprint'
    }
  });
  assert.equal(unsorted.screen, 'results');
  assert.deepEqual(unsorted.results.positions.map((row) => row.position), [1, 2]);
  assert.equal(unsorted.results.positions[0].bestLapSeconds, 14.9);
});

test('every screen maps to a deterministic URL route', () => {
  const routes = new Map();
  routes.set('main-menu', makeState({ screen: 'main-menu' }));
  routes.set('mode-select', makeState({ screen: 'mode-select' }));
  routes.set('car-select', makeState({ screen: 'car-select', mode: 'lap', carSlug: 'audi-r8v10-stock' }));
  routes.set('map-select', makeState({ screen: 'map-select', mode: 'sprint', carSlug: 'audi-r8v10-stock', mapId: 'gracia' }));
  routes.set('lobby', makeState({
    screen: 'lobby', mode: 'multiplayer', carSlug: 'audi-r8v10-stock', mapId: 'river',
    mp: { role: 'guest', roomCode: 'KRP3Q' }
  }));
  for (const [screen, state] of routes) {
    const route = routeForScreen(state);
    assert.equal(route.shell, '1', screen);
    assert.equal(typeof toQuery(route), 'string');
  }
  assert.equal(routeForScreen(routes.get('mode-select')).screen, 'mode');
  assert.equal(routeForScreen(routes.get('car-select')).screen, 'car');
  assert.equal(routeForScreen(routes.get('map-select')).screen, 'map');
  assert.equal(routeForScreen(routes.get('map-select')).map, 'gracia');
  assert.equal(routeForScreen(routes.get('lobby')).room, 'KRP3Q');
  assert.equal(routeForScreen(routes.get('lobby')).host, '0');

  const solo = makeState({ screen: 'map-select', mode: 'lap', carSlug: 'bmw-m3e92-tuner', mapId: 'river' });
  const started = reduce(solo, { type: 'start', now: 1000 });
  const loadingRoute = routeForScreen(started);
  assert.equal(loadingRoute.screen, 'loading');
  assert.equal(loadingRoute.course, 'lap');
  const running = reduce(started, { type: 'loading/ready', now: 1100 });
  const raceRoute = routeForScreen(running);
  assert.equal(raceRoute.shell, '1');
  assert.equal(raceRoute.car, 'bmw-m3e92-tuner');
  assert.equal(raceRoute.map, 'river');
  assert.equal(raceRoute.course, 'lap');
  assert.equal(raceRoute.screen, undefined);

  const mp = makeState({
    screen: 'lobby', mode: 'multiplayer', carSlug: 'corvette-zr1-stock', mapId: 'amboy',
    mp: { role: 'host', roomCode: 'KRP3Q', verified: true }
  });
  let mpState = reduce(mp, { type: 'mp/set-ai', count: 2 });
  mpState = reduce(mpState, { type: 'mp/set-ready', ready: true });
  mpState = reduce(mpState, { type: 'start', now: 1000 });
  const query = engineQueryFor(mpState.lastConfig);
  assert.equal(query.mp, '1');
  assert.equal(query.host, '1');
  assert.equal(query.ai, '2');
  assert.equal(query.aiCars.split(',').length, 2);
});

test('grid navigation and gamepad intents are edge-triggered', () => {
  assert.equal(nextGridIndex(0, 61, 'ArrowRight', 7), 1);
  assert.equal(nextGridIndex(0, 61, 'ArrowDown', 7), 7);
  assert.equal(nextGridIndex(6, 61, 'ArrowRight', 7), 7);
  assert.equal(nextGridIndex(0, 61, 'ArrowLeft', 7), 0);
  assert.equal(nextGridIndex(56, 61, 'ArrowDown', 7), 56);
  assert.equal(nextGridIndex(3, 61, 'Home', 7), 0);
  assert.equal(nextGridIndex(3, 61, 'End', 7), 60);
  const buttons = (pressed) => pressed.map((value) => ({ pressed: value }));
  assert.equal(gamepadIntent(buttons([true, false]), [], { buttons: [false, false], axes: [] }), 'confirm');
  assert.equal(gamepadIntent(buttons([true, false]), [], { buttons: [true, false], axes: [] }), null);
  assert.equal(gamepadIntent(buttons([false, true]), [], { buttons: [false, false], axes: [] }), 'back');
  assert.equal(gamepadIntent(buttons([]), [0, -0.8], { buttons: [], axes: [0, 0] }), 'up');
  assert.equal(gamepadIntent(buttons([]), [0, -0.8], { buttons: [], axes: [0, -0.8] }), null);
});

test('config signatures are stable and include the multiplayer AI roster', () => {
  let state = makeState({
    screen: 'lobby', mode: 'multiplayer', carSlug: 'corvette-zr1-stock', mapId: 'river',
    mp: { role: 'host', roomCode: 'KRP3Q', verified: true }
  });
  const first = configSignature(startRejection(state).config ?? null);
  assert.equal(first, '');
  state = reduce(state, { type: 'mp/set-ai', count: 1 });
  state = reduce(state, { type: 'mp/set-ready', ready: true });
  const config = startRejection(state).config;
  assert.equal(configSignature(config), configSignature(config));
  assert.match(configSignature(config), /multiplayer\|310\|corvette-zr1-stock\|river/);
});

test('format helpers do not invent precision', () => {
  assert.equal(formatMetres(310.395196), '310.395 m');
  assert.equal(formatMetres(2060.595408), '2,060.595 m');
  assert.equal(formatMetres(undefined), null);
  assert.equal(measuredLength({ lengths: {} }, 'sprint').text, 'length not recorded');
});
