// Game shell integration for the E1 drive slice.
//
// The shell (probes/game-shell) owns every menu decision; this module only
// supplies the committed data and turns the shell's `start` config into the URL
// the driving slice already understands. There is no URL editing involved:
// a bare page load opens the menu, and the race page is a normal navigation.
//
// Existing deep links keep working because `boot.js` sends any race parameter
// straight to `app.js` without mounting this module.

import { MAPS } from './map-registry.js';
import { mount } from '/game-shell/shell.js';

// Read the entry query before the shell mounts: `syncUrl` rewrites the address
// bar, so a later read would no longer see `?join=1`.
const JOIN_MODE = new URLSearchParams(location.search).get('join') === '1';

const ROSTER_URL = '/_work/e1-drive/cars.json';
const CLASSES_URL = '/game-shell/data/car-classes.json';
const MEASUREMENTS_URL = '/game-shell/data/course-measurements.json';

function shellStyles() {
  if (document.querySelector('link[data-game-shell]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/game-shell/shell.css';
  link.dataset.gameShell = '1';
  document.head.appendChild(link);
}

function host() {
  let element = document.getElementById('game-menu');
  if (!element) {
    element = document.createElement('div');
    element.id = 'game-menu';
    element.setAttribute('aria-label', 'Blur Web game shell');
    document.body.appendChild(element);
  }
  return element;
}

/** A race URL the driving slice already understands. */
export function raceUrl(config) {
  if (!config) throw new Error('raceUrl needs a shell config');
  const query = new URLSearchParams();
  query.set('race', '1');
  if (config.mode === 'multiplayer') {
    query.set('mp', '1');
    if (config.mp?.powerups) query.set('powerups', '1');
    if (config.mp?.role === 'host') {
      query.set('host', '1');
      if (config.mapId) query.set('map', config.mapId);
      if (config.mp.aiCount > 0) {
        query.set('ai', String(config.mp.aiCount));
        query.set('aiCars', config.mp.aiCars.join(','));
        query.set('aiProfiles', config.mp.aiProfiles.join(','));
      }
    } else {
      query.set('room', config.mp?.roomCode ?? '');
    }
  } else {
    if (config.mapId) query.set('map', config.mapId);
    if (config.course) query.set('course', config.course);
  }
  if (config.carSlug) query.set('car', config.carSlug);
  return '?' + query.toString();
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error('HTTP ' + response.status + ' for ' + url);
  return response.json();
}

shellStyles();
const shell = mount(host(), {
  cars: [],
  maps: [],
  initial: { screen: 'boot' },
  syncUrl: true,
  now: () => Date.now(),
  loadingTimeoutMs: 30000
});
window.__gameShell = shell;
shell.enableGamepad();

function startRace(config) {
  location.assign(raceUrl(config));
}

shell.on('start', startRace);

// The shell lobby is a metadata editor; the driving page owns the real room
// connection and ready/start handshake. Once a host has a map (or a guest has a
// valid room code) hand over immediately so the in-game lobby keeps working.
//
// `?join=1` is the guest entry: the menu opens straight into the multiplayer
// lobby with the guest role, so the player can type the 5-character code the
// host shared. Without it the default role is host and the handover is
// immediate, which is what a host wants.
let handedOver = false;
function handOverLobby() {
  if (handedOver) return;
  const state = shell.getState();
  if (state.screen !== 'lobby' || state.mode !== 'multiplayer') return;
  const config = {
    mode: 'multiplayer',
    course: '310',
    carSlug: state.carSlug ?? null,
    mapId: state.mp?.mapId ?? state.mapId ?? null,
    mp: {
      role: state.mp?.role ?? 'host',
      roomCode: state.mp?.roomCode ?? '',
      powerups: state.mp?.powerups === true,
      aiCount: state.mp?.ai?.count ?? 0,
      aiCars: (state.mp?.ai?.rows ?? []).map((row) => row.car),
      aiProfiles: (state.mp?.ai?.rows ?? []).map((row) => row.profile)
    }
  };
  if (config.mp.role === 'guest' && state.mp?.roomCodeValid !== true) return;
  handedOver = true;
  startRace(config);
}

setInterval(handOverLobby, 250);

Promise.all([
  fetchJson(ROSTER_URL),
  fetchJson(CLASSES_URL),
  fetchJson(MEASUREMENTS_URL)
]).then(([roster, classes, measurements]) => {
  if (roster?.kind !== 'e1-drive.car-roster' || roster.status !== 'PASS') {
    throw new Error('roster is not a passing e1-drive.car-roster');
  }
  if (classes?.kind !== 'game-shell.car-classes') {
    throw new Error('classes are not a game-shell.car-classes document');
  }
  if (measurements?.kind !== 'game-shell.course-measurements') {
    throw new Error('measurements are not a game-shell.course-measurements document');
  }
  shell.setData({
    cars: roster,
    maps: MAPS,
    classes: classes.classes,
    measurements: measurements.maps
  });
  shell.bootReady();
  if (JOIN_MODE) openGuestLobby();
}).catch((error) => {
  shell.bootFail({ code: 'SHELL_BOOT_FAILED', message: error.message });
});

/**
 * `?join=1`: walk the shell to the multiplayer lobby with the guest role so the
 * player can type the room code. Every step is a normal shell action; no URL is
 * edited and the handover still happens through `handOverLobby`.
 */
function openGuestLobby() {
  const state = shell.getState();
  shell.dispatch({ type: 'menu/play' });
  shell.selectMode('multiplayer');
  if (state.carSlug) shell.selectCar(state.carSlug);
  shell.confirmCar();
  shell.selectMap('river');
  shell.openLobby();
  shell.dispatch({ type: 'mp/set-role', role: 'guest' });
}
