import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAPS } from '../../e1-drive/web/map-registry.js';
import { createShellState, reduce } from '../shell-state.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');

export function readJson(relative) {
  return JSON.parse(readFileSync(path.join(ROOT, relative), 'utf8'));
}

let cached = null;

export function dataset() {
  if (cached) return cached;
  const roster = readJson('probes/e1-drive/cars/roster.json');
  const classes = readJson('probes/game-shell/data/car-classes.json');
  const measurements = readJson('probes/game-shell/data/course-measurements.json');
  cached = { roster, classes, measurements, maps: MAPS };
  return cached;
}

export function makeState(initial = {}, extra = {}) {
  const data = dataset();
  return createShellState({
    cars: data.roster,
    maps: data.maps,
    classes: data.classes.classes,
    measurements: data.measurements.maps,
    initial: { screen: 'main-menu', ...initial },
    now: 1000,
    loadingTimeoutMs: 1000,
    ...extra
  });
}

export function walkTo(state, actions) {
  let current = state;
  for (const action of actions) {
    current = current && action.type ? reduce(current, action) : current;
  }
  return current;
}
