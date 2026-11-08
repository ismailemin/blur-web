/**
 * Deterministic fixtures shared by the preview page and the unit suite.
 * The only minimap geometry here is an explicit synthetic oval, labelled as
 * such; no retail track data is embedded or invented.
 */

export function syntheticMinimap() {
  const points = [];
  for (let i = 0; i < 24; i += 1) {
    const t = (i / 24) * Math.PI * 2;
    points.push([Math.cos(t) * 210, Math.sin(t) * 128]);
  }
  points.push(points[0]);
  return {
    version: 'MINIMAP1',
    map: 'preview-synthetic-loop',
    source: 'synthetic-preview-not-retail',
    closed: true,
    points,
    start: { x: points[0][0], z: points[0][1] },
    finish: { x: points[0][0], z: points[0][1] },
    checkpoints: [
      { x: 210, z: 0, label: 'CP1' },
      { x: 0, z: 128, label: 'CP2' }
    ],
    pickups: [
      { x: 148, z: 90, type: 'Bomb' },
      { x: -148, z: -90, type: 'Shield' }
    ]
  };
}

function carsMp() {
  return [
    { id: 'local', name: 'Host', kind: 'local', x: 148, z: 62, headingRad: 1.2, position: 2, lap: 2, speedMps: 41.2, connected: true },
    { id: 'remote', name: 'Guest', kind: 'remote', x: 96, z: 96, headingRad: 1.35, position: 1, lap: 2, speedMps: 44.1, connected: true },
    { id: 'ai-1', name: 'AI 1', kind: 'ai', x: 26, z: 122, headingRad: 2.1, position: 3, lap: 2, speedMps: 39.0, connected: true },
    { id: 'ai-2', name: 'AI 2', kind: 'ai', x: -64, z: 104, headingRad: 2.7, position: 4, lap: 2, speedMps: 38.4, connected: true },
    { id: 'ai-3', name: 'AI 3', kind: 'ai', x: -148, z: 58, headingRad: 3.4, position: 5, lap: 1, speedMps: 36.8, connected: true },
    { id: 'ai-4', name: 'AI 4', kind: 'ai', x: -186, z: -34, headingRad: 4.2, position: 6, lap: 1, speedMps: 35.2, connected: true },
    { id: 'ai-5', name: 'AI 5', kind: 'ai', x: -96, z: -112, headingRad: 5.1, position: 7, lap: 1, speedMps: 33.1, connected: true },
    { id: 'ai-6', name: 'AI 6', kind: 'ai', x: 42, z: -124, headingRad: 5.9, position: 8, lap: 1, speedMps: 31.7, connected: true }
  ];
}

export function stateSolo() {
  return {
    version: 1,
    mode: 'solo',
    course: { id: 'river-310', label: 'River 310 m', laps: 1 },
    local: {
      id: 'local',
      name: 'Driver',
      car: 'corvette-zr1-stock',
      speedMps: 41.2,
      gear: 4,
      rpm: 6100,
      rpmMax: 8000,
      redline: 7000,
      health: { current: 100, max: 100 },
      shield: { current: null, max: null, secondsLeft: null },
      boost: { kind: null, remainingSeconds: null, capacitySeconds: null },
      powerup: { type: null, charges: null, secondsLeft: null },
      position: 1,
      totalPositions: 1,
      lap: 1,
      raceTimeSeconds: 42.318,
      lastLapSeconds: 28.551,
      bestLapSeconds: 28.4,
      deltaSeconds: 0.151
    },
    timing: { raceSeconds: 42.318, countdownLabel: null, finished: false },
    session: { status: 'solo', latencyMs: null, roomCode: null },
    cars: [
      { id: 'local', name: 'Driver', kind: 'local', x: 148, z: 62, headingRad: 1.2, position: 1, lap: 1, speedMps: 41.2 }
    ],
    results: null
  };
}

export function stateMp() {
  const base = stateSolo();
  base.mode = 'multiplayer';
  base.course = { id: 'river-310', label: 'River 310 m', laps: 3 };
  base.local = {
    ...base.local,
    position: 2,
    totalPositions: 8,
    lap: 2,
    health: { current: 78, max: 100 },
    shield: { current: 50, max: 50, secondsLeft: 4.25 },
    boost: { kind: 'nitro', remainingSeconds: 0.8, capacitySeconds: 1.3 },
    powerup: { type: 'Bomb', charges: 2, secondsLeft: null }
  };
  base.timing = { raceSeconds: 86.412, countdownLabel: null, finished: false };
  base.session = { status: 'connected', latencyMs: 34, roomCode: 'TEST1' };
  base.cars = carsMp();
  return base;
}

export function stateCountdown() {
  const base = stateMp();
  base.timing = { raceSeconds: 0, countdownLabel: '3', finished: false };
  base.local.raceTimeSeconds = 0;
  base.local.lastLapSeconds = null;
  base.local.bestLapSeconds = null;
  base.local.deltaSeconds = null;
  return base;
}

export function stateWrecked() {
  const base = stateMp();
  base.local.speedMps = 0;
  base.local.health = { current: 0, max: 100 };
  base.local.shield = { current: 0, max: 50, secondsLeft: null };
  base.local.boost = { kind: null, remainingSeconds: null, capacitySeconds: null };
  base.local.powerup = { type: null, charges: null, secondsLeft: null };
  base.banner = { text: 'WRECKED · respawn in 1.0 s', kind: 'danger' };
  base.warning = { level: 'danger', text: 'WRECKED' };
  return base;
}

export function stateFinish() {
  const base = stateMp();
  base.timing = { raceSeconds: 86.211, countdownLabel: null, finished: true };
  base.banner = { text: 'FINISH · 1:26.211', kind: 'finish' };
  base.local.lastLapSeconds = 28.402;
  base.local.bestLapSeconds = 28.4;
  base.local.deltaSeconds = 0.002;
  base.results = [
    { playerId: 'remote', name: 'Guest', positionNumber: 1, timeSeconds: 85.902, bestLapSeconds: 28.101, status: 'finished', kind: 'remote', host: false, ai: false, self: false },
    { playerId: 'local', name: 'Host', positionNumber: 2, timeSeconds: 86.211, bestLapSeconds: 28.4, status: 'finished', kind: 'local', host: true, ai: false, self: true },
    { playerId: 'ai-1', name: 'AI 1', positionNumber: 3, timeSeconds: 88.03, bestLapSeconds: 28.9, status: 'finished', ai: true, self: false },
    { playerId: 'ai-2', name: 'AI 2', positionNumber: 4, timeSeconds: 89.44, bestLapSeconds: 29.2, status: 'finished', ai: true, self: false },
    { playerId: 'ai-3', name: 'AI 3', positionNumber: 5, timeSeconds: 91.02, bestLapSeconds: 29.8, status: 'finished', ai: true, self: false },
    { playerId: 'ai-4', name: 'AI 4', positionNumber: 6, timeSeconds: 92.77, bestLapSeconds: 30.1, status: 'finished', ai: true, self: false },
    { playerId: 'ai-5', name: 'AI 5', positionNumber: 7, timeSeconds: 94.15, bestLapSeconds: 30.6, status: 'finished', ai: true, self: false },
    { playerId: 'ai-6', name: 'AI 6', positionNumber: 8, timeSeconds: null, bestLapSeconds: 31.2, status: 'dnf', ai: true, self: false }
  ];
  return base;
}

export function stateMissing() {
  return {
    version: 1,
    mode: 'solo',
    course: {},
    local: {
      speedMps: null,
      gear: null,
      rpm: null,
      rpmMax: null,
      redline: null,
      health: { current: null, max: null },
      shield: { current: null, max: null, secondsLeft: null },
      boost: { kind: null, remainingSeconds: null, capacitySeconds: null },
      powerup: { type: null, charges: null, secondsLeft: null },
      position: null,
      totalPositions: null,
      lap: null,
      raceTimeSeconds: null,
      lastLapSeconds: null,
      bestLapSeconds: null,
      deltaSeconds: null
    },
    timing: { raceSeconds: null, countdownLabel: null, finished: false },
    session: {},
    cars: [],
    results: null
  };
}

export function stateWithNaN() {
  const base = stateSolo();
  base.local.speedMps = NaN;
  base.local.gear = NaN;
  base.local.rpm = NaN;
  base.local.rpmMax = Infinity;
  base.local.redline = -Infinity;
  base.local.position = NaN;
  base.local.lap = NaN;
  base.local.lastLapSeconds = NaN;
  base.local.bestLapSeconds = Infinity;
  base.local.deltaSeconds = NaN;
  base.local.health = { current: NaN, max: null };
  base.local.shield = { current: Infinity, max: 50, secondsLeft: NaN };
  base.local.boost = { kind: 'nitro', remainingSeconds: NaN, capacitySeconds: 1.3 };
  base.local.powerup = { type: 'Bomb', charges: NaN, secondsLeft: NaN };
  base.timing = { raceSeconds: NaN, countdownLabel: null, finished: false };
  base.session = { status: 'connected', latencyMs: NaN };
  base.cars = [{ id: 'local', kind: 'local', x: NaN, z: NaN, headingRad: NaN }];
  return base;
}

export function stateFor(name) {
  switch (name) {
    case 'mp': return stateMp();
    case 'countdown': return stateCountdown();
    case 'wrecked': return stateWrecked();
    case 'finish': return stateFinish();
    case 'missing': return stateMissing();
    case 'nan': return stateWithNaN();
    case 'solo':
    default: return stateSolo();
  }
}

export const PREVIEW_STATES = Object.freeze(['solo', 'mp', 'countdown', 'wrecked', 'finish', 'missing']);
