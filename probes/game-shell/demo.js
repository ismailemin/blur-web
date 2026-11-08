// Standalone shell demo.
//
// Data is read from the committed files at request time; nothing is copied:
//   /probes/e1-drive/cars/roster.json        (25 cars)
//   /probes/e1-drive/web/map-registry.js     (River/Amboy/Gracia)
//   ./data/car-classes.json                  (generated from the roster)
//   ./data/course-measurements.json          (measured lengths, sourced)
//
// The demo never imports the driving page and never reloads. The race screen is
// explicitly a shell-only screen; the engine is mounted by the integration.

import { MAPS } from '/probes/e1-drive/web/map-registry.js';
import { mount } from './shell.js';

const ROSTER_URL = '/probes/e1-drive/cars/roster.json';
const CLASSES_URL = './data/car-classes.json';
const MEASUREMENTS_URL = './data/course-measurements.json';

const params = new URLSearchParams(location.search);
const host = document.getElementById('shell');

const shell = mount(host, {
  cars: [],
  maps: [],
  initial: { screen: 'boot' },
  demo: true,
  syncUrl: true,
  now: () => Date.now(),
  loadingTimeoutMs: 15000
});

window.__gameShell = shell;
shell.enableGamepad();

async function fetchJson(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error('HTTP ' + response.status + ' for ' + url);
  }
  return response.json();
}

async function loadData() {
  const [roster, classes, measurements] = await Promise.all([
    fetchJson(ROSTER_URL),
    fetchJson(CLASSES_URL),
    fetchJson(MEASUREMENTS_URL)
  ]);
  if (roster?.kind !== 'e1-drive.car-roster' || !Array.isArray(roster.cars)) {
    throw new Error('roster is not an e1-drive.car-roster');
  }
  if (classes?.kind !== 'game-shell.car-classes') {
    throw new Error('classes are not a game-shell.car-classes document');
  }
  if (measurements?.kind !== 'game-shell.course-measurements') {
    throw new Error('measurements are not a game-shell.course-measurements document');
  }
  return { roster, classes, measurements };
}

function deepLink() {
  const screen = params.get('screen');
  const mode = params.get('mode') ?? 'sprint';
  if (!screen || screen === 'menu') return;

  // main-menu -> mode -> ...; the public methods guard out-of-order calls.
  shell.dispatch({ type: 'menu/play' });
  shell.selectMode(mode);
  const car = params.get('car');
  if (car) shell.selectCar(car);
  if (screen === 'car') return;

  shell.confirmCar();
  const map = params.get('map');
  if (map) shell.selectMap(map);
  if (screen === 'map') return;

  if (mode === 'multiplayer') {
    shell.setRole(params.get('host') === '0' ? 'guest' : 'host');
    if (params.get('room')) shell.setRoomCode(params.get('room'));
    shell.openLobby();
    if (params.has('ai')) shell.setAi({ count: Number(params.get('ai')) });
    if (params.get('ready') === '1') shell.setReady(true);
  }
}

loadData()
  .then(({ roster, classes, measurements }) => {
    shell.setData({
      cars: roster,
      maps: MAPS,
      classes: classes.classes,
      measurements: measurements.maps
    });
    window.__gameShellData = {
      rosterCars: roster.cars.length,
      maps: Object.keys(MAPS),
      classCounts: classes.counts,
      measurements: measurements.maps
    };
    shell.bootReady();
    deepLink();
  })
  .catch((error) => {
    shell.bootFail({ code: 'SHELL_BOOT_FAILED', message: error.message });
  });

// A start is followed by a fake loading phase; the integration replaces this
// with raceReady() from the engine after the wasm world and map hashes exist.
let loadingTimer = null;
function fakeLoad(config) {
  if (loadingTimer !== null) clearTimeout(loadingTimer);
  loadingTimer = setTimeout(() => {
    loadingTimer = null;
    shell.raceReady();
  }, 700);
}

shell.on('start', (config) => {
  fakeLoad(config);
});

shell.on('retry', () => {
  fakeLoad(shell.getState().lastConfig);
});

shell.on('rematch', ({ screen }) => {
  if (screen === 'loading') fakeLoad(shell.getState().lastConfig);
});
