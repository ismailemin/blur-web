// Pure state machine for the Blur Web game shell.
//
// No DOM, no framework, no timers. `shell.js` is a thin renderer over this
// module and the Node tests exercise every transition without a browser.
//
// Data bindings (all real, none invented here):
//   * cars  -> probes/e1-drive/cars/roster.json (61 committed RP_CarDynamics
//              records; 62 records exist, 1 is unsupported by the builder)
//   * maps  -> probes/e1-drive/web/map-registry.js (13 registered maps)
//   * class -> the vehicle pipeline content class A/B/C, generated from the
//              committed roster + vehicle-batch spec by
//              probes/game-shell/tools/build-car-classes.mjs
//   * length-> measured course values passed in as `measurements`
//
// The content class is the vehicle-pipeline completeness class (A = proven,
// B = exact model + data, C = alias-resolved record without a normalised model
// entry). It is NOT a retail Blur race class; the UI labels it "data class".

export const SHELL_VERSION = 1;

export const SCREENS = Object.freeze([
  'boot', 'main-menu', 'mode-select', 'car-select', 'map-select', 'lobby',
  'loading', 'race', 'results'
]);

export const MODES = Object.freeze({
  sprint: Object.freeze({
    id: 'sprint',
    label: 'Sprint',
    course: '310',
    tagline: 'Point-to-point against the clock',
    description: 'The measured 310 m River course or a full map package path. Countdown, two checkpoints, finish.'
  }),
  lap: Object.freeze({
    id: 'lap',
    label: '3-Lap',
    course: 'lap',
    tagline: 'Closed loop, three laps',
    description: 'The measured 222.040 m River loop-01 or the 284.452 m Amboy loop-01, three laps, best-lap timing.'
  }),
  free: Object.freeze({
    id: 'free',
    label: 'Free Roam',
    course: 'free',
    tagline: 'No gates, no timer',
    description: 'The 7,702.25 m2 P65/P68 spawn basin. No checkpoints, finish or lap. River only.'
  }),
  multiplayer: Object.freeze({
    id: 'multiplayer',
    label: 'Multiplayer',
    course: '310',
    tagline: 'Host-authoritative online room',
    description: 'Two humans plus 0-3 host AI on any registered map. The room uses that map\'s measured 310 m sprint.'
  })
});

export const MODE_ORDER = Object.freeze(['sprint', 'lap', 'free', 'multiplayer']);
export const MODE_IDS = MODE_ORDER;

export const COURSE_LABELS = Object.freeze({
  310: '310 m sprint',
  short: '29 m regression',
  lap: '3-lap loop',
  free: 'free roam'
});

export const AI_PROFILES = Object.freeze(['cautious', 'standard', 'reference']);
export const AI_PROFILE_SPEED = Object.freeze({ cautious: 0.85, standard: 0.95, reference: 1.0 });
export const AI_MAX = 3;
export const AI_DEFAULT_PROFILES = Object.freeze(['reference', 'standard', 'cautious']);
export const AI_SPAWN_UNSUPPORTED = 'ai-spawn-unsupported';
export const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 5;
export const DEFAULT_LOADING_TIMEOUT_MS = 15000;

/** Vehicle-pipeline content classes plus the explicit "no class" value. */
export const CAR_CLASSES = Object.freeze(['A', 'B', 'C', 'unclassified']);

export const ERROR = Object.freeze({
  BOOT_FAILED: 'SHELL_BOOT_FAILED',
  UNKNOWN_MODE: 'SHELL_UNKNOWN_MODE',
  UNKNOWN_CAR: 'SHELL_UNKNOWN_CAR',
  UNKNOWN_MAP: 'SHELL_UNKNOWN_MAP',
  UNSUPPORTED_COMBINATION: 'SHELL_UNSUPPORTED_COMBINATION',
  START_REJECTED: 'SHELL_START_REJECTED',
  LOBBY_REQUIRED: 'SHELL_LOBBY_REQUIRED',
  ROOM_CODE: 'SHELL_ROOM_CODE',
  MAP_UNVERIFIED: 'SHELL_MAP_UNVERIFIED',
  AI_COUNT: 'SHELL_AI_COUNT',
  AI_UNSUPPORTED: 'SHELL_AI_UNSUPPORTED',
  POWERUPS_RIVER_ONLY: 'SHELL_POWERUPS_RIVER_ONLY',
  LOAD_TIMEOUT: 'SHELL_LOAD_TIMEOUT',
  LOAD_FAILED: 'SHELL_LOAD_FAILED',
  RESULT_INVALID: 'SHELL_RESULT_INVALID',
  NOT_READY: 'SHELL_NOT_READY',
  HOST_ONLY: 'SHELL_HOST_ONLY'
});

/** The legal screen graph. Back navigation uses BACK_TARGETS below. */
export const TRANSITIONS = Object.freeze({
  boot: Object.freeze(['main-menu']),
  'main-menu': Object.freeze(['mode-select']),
  'mode-select': Object.freeze(['car-select', 'main-menu']),
  'car-select': Object.freeze(['map-select', 'mode-select']),
  'map-select': Object.freeze(['lobby', 'loading', 'car-select']),
  lobby: Object.freeze(['loading', 'map-select', 'main-menu']),
  loading: Object.freeze(['race', 'lobby', 'map-select']),
  race: Object.freeze(['results', 'main-menu']),
  results: Object.freeze(['loading', 'lobby', 'main-menu'])
});

export const BACK_TARGETS = Object.freeze({
  boot: null,
  'main-menu': null,
  'mode-select': 'main-menu',
  'car-select': 'mode-select',
  'map-select': 'car-select',
  lobby: 'map-select',
  loading: 'map-select', // resolved to `lobby` for a multiplayer config
  race: 'main-menu',
  results: 'main-menu'
});

export const SCREEN_STEPS = Object.freeze({
  boot: 0,
  'main-menu': 0,
  'mode-select': 1,
  'car-select': 2,
  'map-select': 3,
  lobby: 4,
  loading: 5,
  race: 5,
  results: 6
});

export const STEP_LABELS = Object.freeze(['MENU', 'MODE', 'CAR', 'MAP', 'LOBBY', 'RACE', 'RESULT']);

export function shellError(code, message, detail = null) {
  return { code, message, detail };
}

export function canTransition(from, to) {
  return Boolean(TRANSITIONS[from]?.includes(to));
}

export function normalizeRoomCode(value) {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  if (code.length !== ROOM_CODE_LENGTH) return null;
  for (const character of code) if (!ROOM_ALPHABET.includes(character)) return null;
  return code;
}

export function normalizePlayerName(value, fallback = 'Player') {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 24);
  return text || fallback;
}

/** Vehicle-pipeline content class, not a retail race class. */
export function parseLayout(layout) {
  const text = typeof layout === 'string' ? layout.trim() : '';
  const match = /^(RWD|FWD|AWD)\s*,\s*(\d+(?:\.\d+)?)\s*kg\s*,\s*(\d+)\s*[- ]speed$/i.exec(text);
  if (match) {
    return {
      drivetrain: match[1].toUpperCase(),
      massKg: Number(match[2]),
      gearbox: match[3] + '-speed',
      layout: text,
      parsed: true
    };
  }
  const drive = /\b(RWD|FWD|AWD)\b/i.exec(text);
  const mass = /\b(\d+(?:\.\d+)?)\s*kg\b/i.exec(text);
  const gears = /\b(\d+)\s*[- ]speed\b/i.exec(text);
  return {
    drivetrain: drive ? drive[1].toUpperCase() : null,
    massKg: mass ? Number(mass[1]) : null,
    gearbox: gears ? gears[1] + '-speed' : null,
    layout: text,
    parsed: false
  };
}

function rosterArray(input) {
  if (Array.isArray(input)) return input;
  if (Array.isArray(input?.cars)) return input.cars;
  if (Array.isArray(input?.roster?.cars)) return input.roster.cars;
  return [];
}

/** Normalise the committed roster document into the shell's car records. */
export function normalizeCars(input, classes = {}) {
  const list = rosterArray(input);
  return list.map((entry, index) => {
    const slug = String(entry.slug ?? '');
    const layout = parseLayout(entry.layout);
    const klass = entry.carClass ?? entry.class ?? classes[slug] ?? null;
    const name = String(entry.name ?? slug);
    // `roster.json` stores the record identity at the top level; the generated
    // `_work/e1-drive/cars.json` nests it under `record`. Read both, never guess.
    const recordIndex = Number.isInteger(entry.recordIndex)
      ? entry.recordIndex
      : Number.isInteger(entry.record?.index) ? entry.record.index : null;
    const recordId = entry.recordId ?? entry.record?.id ?? null;
    return {
      slug,
      name,
      rosterIndex: recordIndex ?? index,
      recordId,
      recordIndex,
      carClass: klass,
      class: klass,
      drivetrain: layout.drivetrain,
      massKg: layout.massKg,
      gearbox: layout.gearbox,
      layout: layout.layout,
      layoutParsed: layout.parsed,
      model: entry.model ?? null,
      icon: 'not-decoded',
      searchText: (name + ' ' + slug + ' ' + layout.layout).toLowerCase()
    };
  });
}

function mapArray(input) {
  if (Array.isArray(input)) return input;
  if (input && typeof input === 'object') return Object.values(input);
  return [];
}

/** Normalise the map registry; lengths come from `measurements` and map pins. */
export function normalizeMaps(input, measurements = {}) {
  return mapArray(input).map((entry) => {
    const id = String(entry.id ?? '');
    const measured = measurements[id] ?? {};
    const lengths = { ...measured };
    const pinnedLength = entry.pins?.pathLengthMetres;
    if (Number.isFinite(pinnedLength) && lengths['310'] == null) lengths['310'] = pinnedLength;
    return {
      id,
      label: String(entry.label ?? id),
      level: entry.level ?? null,
      kind: entry.kind ?? null,
      courses: Array.isArray(entry.courses) ? [...entry.courses] : [],
      multiplayer: entry.multiplayer === true,
      lengths,
      pins: entry.pins ?? null,
      mpPins: entry.mpPins ?? null,
      searchText: (id + ' ' + String(entry.label ?? '') + ' ' + String(entry.level ?? '')).toLowerCase()
    };
  });
}

export function courseForMode(mode) {
  return MODES[mode]?.course ?? null;
}

export function modeLabel(mode) {
  return MODES[mode]?.label ?? String(mode);
}

export function courseLabel(course) {
  return COURSE_LABELS[course] ?? String(course);
}

export function mapSupportsMode(map, mode) {
  if (!map || !MODES[mode]) return false;
  const course = MODES[mode].course;
  if (!map.courses.includes(course)) return false;
  if (mode === 'multiplayer') return map.multiplayer === true;
  return true;
}

/** Explicit reason for a disabled mode/map pair; null means supported. */
export function unsupportedReason(map, mode) {
  if (!MODES[mode]) return 'unknown mode ' + JSON.stringify(mode) + ' (use ' + MODE_ORDER.join(', ') + ')';
  if (!map) return 'select a map first';
  if (mode === 'multiplayer' && map.multiplayer !== true) {
    return map.label + ' is not enabled for the online room (multiplayer:false)';
  }
  if (!map.courses.includes(MODES[mode].course)) {
    const packageNote = map.kind === 'map-package'
      ? ' - the E1 package exposes only ' + map.courses.map((course) => courseLabel(course)).join(', ') +
        ' (no ' + courseLabel(MODES[mode].course) + ' layout)'
      : '';
    return map.label + ' lists courses [' + map.courses.join(', ') + ']; ' + MODES[mode].label +
      " needs course '" + MODES[mode].course + "'" + packageNote;
  }
  return null;
}

function formatNumber(value, digits) {
  if (!Number.isFinite(value)) return null;
  const fixed = Math.abs(value).toFixed(digits);
  const [whole, fraction] = fixed.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return grouped + (fraction ? '.' + fraction : '');
}

export function formatMetres(value, digits = 3) {
  const text = formatNumber(value, digits);
  return text === null ? null : text + ' m';
}

export function formatSeconds(value) {
  if (!Number.isFinite(value)) return null;
  return value.toFixed(3) + ' s';
}

/** Measured length for the active mode. Free roam reports its basin area. */
export function measuredLength(map, mode) {
  if (!map) return { text: 'not recorded', kind: 'missing' };
  const course = courseForMode(mode);
  if (course === 'free') {
    const area = map.lengths.freeAreaM2;
    return Number.isFinite(area)
      ? { text: formatNumber(area, 2) + ' m2 basin', kind: 'area', value: area, unit: 'm2' }
      : { text: 'basin area not recorded', kind: 'missing' };
  }
  const value = map.lengths[course];
  return Number.isFinite(value)
    ? { text: formatMetres(value), kind: 'length', value, unit: 'm' }
    : { text: 'length not recorded', kind: 'missing' };
}

export function sortCarClass(a, b) {
  const order = { A: 0, B: 1, C: 2 };
  const left = a.carClass in order ? order[a.carClass] : 3;
  const right = b.carClass in order ? order[b.carClass] : 3;
  return left - right;
}

/** Deterministic search/filter/sort over the normalised cars. */
export function filterCars(cars, filters = {}) {
  const query = String(filters.query ?? '').trim().toLowerCase();
  const carClass = filters.carClass ?? 'all';
  const drivetrain = filters.drivetrain ?? 'all';
  const sort = filters.sort ?? 'roster';
  const result = cars.filter((car) => {
    if (query && !car.searchText.includes(query)) return false;
    if (carClass !== 'all') {
      if (carClass === 'unclassified') {
        if (car.carClass !== null && car.carClass !== 'unclassified') return false;
      } else if (car.carClass !== carClass) {
        return false;
      }
    }
    if (drivetrain !== 'all' && car.drivetrain !== drivetrain) return false;
    return true;
  });
  const bySlug = (a, b) => a.slug.localeCompare(b.slug);
  if (sort === 'name') result.sort((a, b) => a.name.localeCompare(b.name) || bySlug(a, b));
  else if (sort === 'class') result.sort((a, b) => sortCarClass(a, b) || a.name.localeCompare(b.name) || bySlug(a, b));
  else if (sort === 'mass') result.sort((a, b) => (a.massKg ?? Infinity) - (b.massKg ?? Infinity) || bySlug(a, b));
  else if (sort === 'drivetrain') result.sort((a, b) => String(a.drivetrain).localeCompare(String(b.drivetrain)) || bySlug(a, b));
  else result.sort((a, b) => a.rosterIndex - b.rosterIndex || bySlug(a, b));
  return result;
}

export function aiSpawnSupport(mapId, carSlug) {
  if (mapId === 'gracia' && carSlug === 'dodge-challenger-stock') {
    return {
      ok: false,
      code: AI_SPAWN_UNSUPPORTED,
      reason: 'Gracia: the Dodge Challenger front axle is unloaded at the committed start pose ' +
        '(driver-owner measured 7 respawns/DNF); pick another car'
    };
  }
  return { ok: true, code: null, reason: null };
}

function defaultAiCar(cars, index, hostCar) {
  if (!cars.length) return null;
  const candidates = cars.filter((car) => car.slug !== hostCar);
  const pool = candidates.length ? candidates : cars;
  return pool[index % pool.length]?.slug ?? null;
}

function makeAiRow(cars, index, hostCar, carSlug = null, profile = null) {
  return {
    car: carSlug ?? defaultAiCar(cars, index, hostCar),
    profile: profile ?? AI_DEFAULT_PROFILES[index] ?? 'standard'
  };
}

function normalizeAi(aiInput, cars, hostCar, mapId) {
  const countRaw = Number(aiInput?.count ?? 0);
  const count = Number.isInteger(countRaw) ? Math.max(0, Math.min(AI_MAX, countRaw)) : 0;
  const requestedCars = Array.isArray(aiInput?.cars) ? aiInput.cars : [];
  const requestedProfiles = Array.isArray(aiInput?.profiles) ? aiInput.profiles : [];
  const rows = [];
  for (let index = 0; index < count; index++) {
    const row = makeAiRow(cars, index, hostCar, requestedCars[index] ?? null, requestedProfiles[index] ?? null);
    if (!cars.some((car) => car.slug === row.car)) row.car = defaultAiCar(cars, index, hostCar);
    if (!AI_PROFILES.includes(row.profile)) row.profile = AI_DEFAULT_PROFILES[index] ?? 'standard';
    rows.push(row);
  }
  return { count, rows, mapId };
}

function selfPlayer(carSlug, role, name = 'You') {
  return {
    id: 'you',
    name: normalizePlayerName(name, 'You'),
    host: role === 'host',
    ready: false,
    connected: true,
    car: carSlug,
    ai: false
  };
}

function normalizePlayers(players, fallback) {
  const list = Array.isArray(players) ? players : [];
  const normalised = list.map((player, index) => ({
    id: String(player.id ?? 'player-' + (index + 1)),
    name: normalizePlayerName(player.name, 'Player ' + (index + 1)),
    host: player.host === true,
    ready: player.ready === true,
    connected: player.connected !== false,
    car: player.car ?? null,
    ai: player.ai === true
  }));
  if (!normalised.length) return [fallback];
  return normalised;
}

export function createShellState(options = {}) {
  const cars = normalizeCars(options.cars ?? [], options.classes ?? {});
  const maps = normalizeMaps(options.maps ?? [], options.measurements ?? {});
  const initial = options.initial ?? {};
  const now = Number(options.now ?? 0);
  const defaultValue = cars.find((car) => car.slug === initial.defaultCarSlug)?.slug ?? cars[0]?.slug ?? null;
  const carSlug = cars.some((car) => car.slug === initial.carSlug) ? initial.carSlug : defaultValue;
  const mode = MODES[initial.mode] ? initial.mode : null;
  const mapId = maps.some((map) => map.id === initial.mapId) ? initial.mapId : null;
  const screen = SCREENS.includes(initial.screen) ? initial.screen : 'main-menu';
  const role = initial.mp?.role === 'guest' ? 'guest' : 'host';
  const roomCodeRaw = typeof initial.mp?.roomCode === 'string' ? initial.mp.roomCode : '';
  const roomCode = normalizeRoomCode(roomCodeRaw) ?? roomCodeRaw.trim().toUpperCase();
  const mpMapId = maps.some((map) => map.id === (initial.mp?.mapId ?? mapId))
    ? (initial.mp?.mapId ?? mapId)
    : (maps.find((map) => map.multiplayer)?.id ?? null);
  const players = normalizePlayers(initial.mp?.players, selfPlayer(carSlug, role));
  const ai = normalizeAi(initial.mp?.ai, cars, carSlug, mpMapId);

  return {
    version: SHELL_VERSION,
    revision: 0,
    screen,
    boot: {
      status: screen === 'boot' ? 'loading' : 'ready',
      error: initial.boot?.error ?? null
    },
    mode,
    carSlug,
    mapId,
    cars,
    maps,
    filters: {
      query: '',
      carClass: 'all',
      drivetrain: 'all',
      sort: 'roster',
      ...(initial.filters ?? {})
    },
    mp: {
      role,
      roomCode,
      roomCodeValid: normalizeRoomCode(roomCode) !== null,
      youId: typeof initial.mp?.youId === 'string' ? initial.mp.youId : 'you',
      ready: false,
      players,
      ai,
      mapId: mpMapId,
      verified: initial.mp?.verified !== false,
      powerups: initial.mp?.powerups === true,
      error: null,
      status: initial.mp?.status ?? ''
    },
    loading: {
      status: 'idle',
      error: null,
      startedAt: null,
      timeoutMs: Number.isFinite(options.loadingTimeoutMs) ? options.loadingTimeoutMs : DEFAULT_LOADING_TIMEOUT_MS,
      attempt: 0
    },
    race: { status: 'idle', config: null, startedAt: null },
    results: null,
    lastConfig: null,
    starts: 0,
    notice: null
  };
}

function bump(state, patch) {
  return { ...state, ...patch, revision: state.revision + 1 };
}

function withNotice(state, code, message, severity = 'error') {
  return bump(state, { notice: { id: state.revision + 1, code, message, severity } });
}

function clearNotice(state, patch) {
  return bump(state, { ...patch, notice: null });
}

function findCar(state, slug) {
  return state.cars.find((car) => car.slug === slug) ?? null;
}

function findMap(state, id) {
  return state.maps.find((map) => map.id === id) ?? null;
}

export function currentMap(state) {
  return findMap(state, state.mapId);
}

export function currentCar(state) {
  return findCar(state, state.carSlug);
}

export function activeMapForConfig(state) {
  if (state.mode === 'multiplayer') return findMap(state, state.mp.mapId) ?? findMap(state, state.mapId);
  return currentMap(state);
}

/** Human-readable one-line summary of the current selection. */
export function selectionSummary(state) {
  const car = currentCar(state);
  const map = activeMapForConfig(state);
  if (!state.mode) return 'No mode selected';
  return [
    modeLabel(state.mode),
    car?.name ?? 'no car',
    map?.label ?? 'no map',
    MODES[state.mode]?.course ?? ''
  ].filter(Boolean).join(' / ');
}

/** The engine configuration a start action would launch. */
export function buildConfig(state) {
  const map = activeMapForConfig(state);
  const car = currentCar(state);
  const mode = state.mode;
  const config = {
    mode,
    course: courseForMode(mode),
    carSlug: car?.slug ?? null,
    carName: car?.name ?? null,
    mapId: map?.id ?? null,
    mapLabel: map?.label ?? null,
    mapLevel: map?.level ?? null,
    mp: null
  };
  if (mode === 'multiplayer') {
    config.mp = {
      role: state.mp.role,
      roomCode: state.mp.roomCode,
      roomCodeValid: normalizeRoomCode(state.mp.roomCode) !== null,
      aiCount: state.mp.ai.count,
      aiCars: state.mp.ai.rows.map((row) => row.car),
      aiProfiles: state.mp.ai.rows.map((row) => row.profile),
      powerups: state.mp.powerups,
      mapId: map?.id ?? null
    };
  }
  return config;
}

export function configSignature(config) {
  if (!config) return '';
  return [
    config.mode,
    config.course,
    config.carSlug,
    config.mapId,
    config.mp?.role ?? '',
    config.mp?.roomCode ?? '',
    config.mp?.aiCount ?? '',
    (config.mp?.aiCars ?? []).join(','),
    (config.mp?.aiProfiles ?? []).join(','),
    config.mp?.powerups ? 'powerups' : ''
  ].join('|');
}

/** Validate the host's AI rows against the same map rule as the drive page. */
export function validateAiRows(state) {
  const errors = [];
  const errorCodes = [];
  const rows = state.mp.ai.rows;
  for (let index = 0; index < state.mp.ai.count; index++) {
    const row = rows[index];
    if (!row) {
      errors.push('AI ' + (index + 1) + ' has no record');
      continue;
    }
    const car = findCar(state, row.car);
    if (!car) {
      errors.push('AI ' + (index + 1) + ' names an unknown car ' + JSON.stringify(row.car));
      continue;
    }
    if (!AI_PROFILES.includes(row.profile)) {
      errors.push('AI ' + (index + 1) + ' names an unknown skill profile ' + JSON.stringify(row.profile) +
        ' (supported: ' + AI_PROFILES.join(', ') + ')');
      continue;
    }
    const support = aiSpawnSupport(state.mp.mapId, car.slug);
    if (!support.ok) {
      errors.push('AI ' + (index + 1) + ' (' + car.slug + '): ' + support.reason);
      errorCodes.push({ ai: index + 1, code: support.code, message: support.reason });
    }
  }
  return { ok: errors.length === 0, errors, errorCodes };
}

/**
 * The start gate. Order and messages match `mpStartRace()` in app.js:
 * participant count, every connected ready, verified map, valid AI records.
 */
export function startRejection(state) {
  if (state.screen === 'lobby') {
    if (state.mode !== 'multiplayer') {
      return { ok: false, code: ERROR.NOT_READY, reason: 'the lobby only starts a multiplayer room' };
    }
    if (state.mp.role !== 'host') {
      return { ok: false, code: ERROR.HOST_ONLY, reason: 'only the host starts the race' };
    }
    const connected = state.mp.players.filter((player) => player.connected !== false);
    const aiCount = state.mp.ai.count;
    if (connected.length + aiCount < 2) {
      return {
        ok: false,
        code: ERROR.START_REJECTED,
        reason: 'start needs a second player or at least one AI (host simulates the AI)'
      };
    }
    if (!connected.every((player) => player.ready)) {
      return { ok: false, code: ERROR.START_REJECTED, reason: 'start needs every connected player ready' };
    }
    if (!state.mp.verified) {
      return { ok: false, code: ERROR.MAP_UNVERIFIED, reason: 'start needs this page to verify the room map first' };
    }
    const ai = validateAiRows(state);
    if (!ai.ok) {
      const codes = ai.errorCodes.map((entry) => entry.code).filter(Boolean).join(',');
      return {
        ok: false,
        code: ERROR.AI_UNSUPPORTED,
        reason: 'start refused' + (codes ? ' (' + codes + ')' : '') + ': ' + ai.errors.join('; ')
      };
    }
    const map = activeMapForConfig(state);
    if (state.mp.error) {
      return { ok: false, code: ERROR.START_REJECTED, reason: 'start rejected: ' + state.mp.error };
    }
    const unsupported = unsupportedReason(map, state.mode);
    if (unsupported) return { ok: false, code: ERROR.UNSUPPORTED_COMBINATION, reason: unsupported };
    return { ok: true, config: buildConfig(state) };
  }

  if (state.screen === 'map-select') {
    if (state.mode === 'multiplayer') {
      return { ok: false, code: ERROR.LOBBY_REQUIRED, reason: 'multiplayer starts from the lobby' };
    }
    if (!state.mode) return { ok: false, code: ERROR.NOT_READY, reason: 'select a mode first' };
    if (!state.carSlug) return { ok: false, code: ERROR.NOT_READY, reason: 'select a car first' };
    if (!state.mapId) return { ok: false, code: ERROR.NOT_READY, reason: 'select a map first' };
    const map = currentMap(state);
    const unsupported = unsupportedReason(map, state.mode);
    if (unsupported) return { ok: false, code: ERROR.UNSUPPORTED_COMBINATION, reason: unsupported };
    return { ok: true, config: buildConfig(state) };
  }

  return {
    ok: false,
    code: ERROR.NOT_READY,
    reason: 'start is only available from map select or the lobby'
  };
}

export function loadingError(state) {
  const error = state.loading.error;
  return error ? shellError(error.code ?? ERROR.LOAD_FAILED, error.message ?? String(error)) : null;
}

function normalizeResult(result) {
  if (!result || !Array.isArray(result.positions) || !result.positions.length) {
    return { ok: false, error: shellError(ERROR.RESULT_INVALID, 'a result needs at least one position row') };
  }
  const positions = [];
  for (const row of result.positions) {
    const position = Number(row.position);
    if (!Number.isInteger(position) || position < 1) {
      return { ok: false, error: shellError(ERROR.RESULT_INVALID, 'every result row needs an integer position >= 1') };
    }
    positions.push({
      position,
      name: String(row.name ?? 'Player ' + position),
      car: row.car ?? null,
      timeSeconds: Number.isFinite(row.timeSeconds) ? row.timeSeconds : null,
      bestLapSeconds: Number.isFinite(row.bestLapSeconds) ? row.bestLapSeconds : null,
      laps: Number.isInteger(row.laps) ? row.laps : null,
      dnf: row.dnf === true,
      ai: row.ai === true,
      note: row.note ?? null
    });
  }
  positions.sort((a, b) => a.position - b.position);
  return {
    ok: true,
    result: {
      positions,
      mode: result.mode ?? null,
      mapId: result.mapId ?? null,
      mapLabel: result.mapLabel ?? null,
      course: result.course ?? null,
      raceId: result.raceId ?? null,
      synthetic: result.synthetic === true,
      source: result.source ?? null
    }
  };
}

/** Pure reducer. Unknown or out-of-order actions leave the screen unchanged. */
export function reduce(state, action = {}) {
  const now = Number(action.now ?? 0);

  switch (action.type) {
    case 'boot/ready':
      if (state.screen !== 'boot') return state;
      return clearNotice(state, { screen: 'main-menu', boot: { status: 'ready', error: null } });

    case 'menu/play': {
      if (state.screen !== 'main-menu') return state;
      return clearNotice(state, { screen: 'mode-select' });
    }

    case 'data/set': {
      const cars = normalizeCars(action.cars ?? state.cars, action.classes ?? {});
      const maps = normalizeMaps(action.maps ?? state.maps, action.measurements ?? {});
      const carSlug = cars.some((car) => car.slug === state.carSlug)
        ? state.carSlug
        : (cars[0]?.slug ?? null);
      const mapId = maps.some((map) => map.id === state.mapId) ? state.mapId : null;
      const mpMapId = maps.some((map) => map.id === state.mp.mapId) ? state.mp.mapId : mapId;
      return bump(state, {
        cars,
        maps,
        carSlug,
        mapId,
        mp: { ...state.mp, mapId: mpMapId, ai: { ...state.mp.ai, mapId: mpMapId } }
      });
    }

    case 'boot/fail': {
      if (state.screen !== 'boot') return state;
      const error = action.error?.message
        ? action.error
        : shellError(ERROR.BOOT_FAILED, String(action.error ?? 'shell boot failed'));
      return bump(state, { boot: { status: 'error', error }, screen: 'boot' });
    }

    case 'mode/select': {
      if (state.screen !== 'mode-select') {
        return withNotice(state, ERROR.NOT_READY, 'choose a mode from the mode screen');
      }
      if (!MODES[action.mode]) {
        return withNotice(state, ERROR.UNKNOWN_MODE,
          'unknown mode ' + JSON.stringify(action.mode) + ' (use ' + MODE_ORDER.join(', ') + ')');
      }
      const mode = action.mode;
      const car = currentCar(state) ?? state.cars[0] ?? null;
      let mapId = state.mapId;
      let next = bump(state, {
        mode,
        screen: 'car-select',
        carSlug: car?.slug ?? null,
        mapId,
        notice: null
      });
      const map = findMap(state, mapId);
      if (map && !mapSupportsMode(map, mode)) {
        next = withNotice(next, ERROR.UNSUPPORTED_COMBINATION, unsupportedReason(map, mode));
      }
      return next;
    }

    case 'car/select': {
      const car = findCar(state, action.slug);
      if (!car) {
        return withNotice(state, ERROR.UNKNOWN_CAR,
          'unknown car ' + JSON.stringify(action.slug) + ' (the roster has ' + state.cars.length + ' cars)');
      }
      return clearNotice(state, { carSlug: car.slug });
    }

    case 'car/confirm': {
      if (!state.mode) return withNotice(state, ERROR.NOT_READY, 'select a mode first');
      if (!state.carSlug) return withNotice(state, ERROR.NOT_READY, 'select a car first');
      return clearNotice(state, { screen: 'map-select' });
    }

    case 'filters/set': {
      const patch = {};
      for (const key of ['query', 'carClass', 'drivetrain', 'sort']) {
        if (action.patch && key in action.patch) patch[key] = action.patch[key];
      }
      return bump(state, { filters: { ...state.filters, ...patch } });
    }

    case 'map/select': {
      if (state.screen !== 'map-select') {
        return withNotice(state, ERROR.NOT_READY, 'choose a map from the map screen');
      }
      const map = findMap(state, action.mapId);
      if (!map) return withNotice(state, ERROR.UNKNOWN_MAP, 'unknown map ' + JSON.stringify(action.mapId));
      if (!state.mode) return withNotice(state, ERROR.NOT_READY, 'select a mode first');
      const reason = unsupportedReason(map, state.mode);
      if (reason) return withNotice(state, ERROR.UNSUPPORTED_COMBINATION, reason);
      return clearNotice(state, { mapId: map.id });
    }

    case 'lobby/open': {
      if (state.mode !== 'multiplayer') {
        return withNotice(state, ERROR.NOT_READY, 'the lobby only opens for multiplayer');
      }
      if (!state.carSlug) return withNotice(state, ERROR.NOT_READY, 'select a car first');
      const map = currentMap(state);
      if (!map) return withNotice(state, ERROR.NOT_READY, 'select a map first');
      const reason = unsupportedReason(map, 'multiplayer');
      if (reason) return withNotice(state, ERROR.UNSUPPORTED_COMBINATION, reason);
      const code = normalizeRoomCode(state.mp.roomCode);
      if (state.mp.role === 'guest' && !code) {
        return withNotice(state, ERROR.ROOM_CODE,
          'room must be 5 characters from ' + ROOM_ALPHABET + ' (got ' + JSON.stringify(state.mp.roomCode) + ')');
      }
      const players = state.mp.role === 'host'
        ? [selfPlayer(state.carSlug, 'host')]
        : [selfPlayer(state.carSlug, 'guest')];
      return clearNotice(state, {
        screen: 'lobby',
        mapId: map.id,
        mp: {
          ...state.mp,
          roomCode: code ?? state.mp.roomCode,
          roomCodeValid: code !== null,
          ready: false,
          players,
          mapId: map.id,
          verified: state.mp.verified,
          error: null,
          status: ''
        }
      });
    }

    case 'start': {
      const gate = startRejection(state);
      if (!gate.ok) {
        return withNotice(state, gate.code, gate.reason);
      }
      return clearNotice(state, {
        screen: 'loading',
        lastConfig: gate.config,
        starts: state.starts + 1,
        loading: {
          ...state.loading,
          status: 'loading',
          error: null,
          startedAt: now,
          attempt: state.loading.attempt + 1
        },
        race: { status: 'loading', config: gate.config, startedAt: now },
        results: null,
        mp: gate.config.mp ? { ...state.mp, ready: state.mp.ready, error: null } : state.mp
      });
    }

    case 'loading/ready': {
      if (state.screen !== 'loading') return state;
      if (state.loading.error) {
        return withNotice(state, ERROR.LOAD_FAILED,
          'retry the loading step before entering the race');
      }
      return clearNotice(state, {
        screen: 'race',
        loading: { ...state.loading, status: 'ready' },
        race: { ...state.race, status: 'running', startedAt: now }
      });
    }

    case 'loading/fail': {
      if (state.screen !== 'loading') return state;
      const input = action.error;
      const error = input?.code
        ? { code: input.code, message: input.message ?? String(input), detail: input.detail ?? null }
        : shellError(ERROR.LOAD_FAILED, input?.message ?? String(input ?? 'race load failed'));
      return bump(state, {
        loading: { ...state.loading, status: 'error', error },
        race: { ...state.race, status: 'error' }
      });
    }

    case 'loading/tick': {
      if (state.screen !== 'loading' || state.loading.status !== 'loading' || state.loading.error) return state;
      const startedAt = state.loading.startedAt;
      const timeout = state.loading.timeoutMs;
      if (startedAt === null || !(timeout > 0)) return state;
      if (now - startedAt < timeout) return state;
      return bump(state, {
        loading: {
          ...state.loading,
          status: 'error',
          error: shellError(ERROR.LOAD_TIMEOUT,
            'race did not report ready within ' + timeout + ' ms (loading timeout)')
        },
        race: { ...state.race, status: 'error' }
      });
    }

    case 'loading/retry': {
      if (state.screen !== 'loading') return state;
      return clearNotice(state, {
        loading: {
          ...state.loading,
          status: 'loading',
          error: null,
          startedAt: now,
          attempt: state.loading.attempt + 1
        },
        race: { ...state.race, status: 'loading', startedAt: now }
      });
    }

    case 'race/finish': {
      if (state.screen !== 'race' && state.screen !== 'loading') {
        return withNotice(state, ERROR.NOT_READY, 'a result can only arrive after the race starts');
      }
      const checked = normalizeResult(action.result);
      if (!checked.ok) return withNotice(state, checked.error.code, checked.error.message);
      return clearNotice(state, {
        screen: 'results',
        results: checked.result,
        race: { ...state.race, status: 'finished' }
      });
    }

    case 'race/quit':
      if (state.screen !== 'race' && state.screen !== 'loading') return state;
      return clearNotice(state, { screen: 'main-menu', race: { status: 'idle', config: null, startedAt: null } });

    case 'results/rematch': {
      if (state.screen !== 'results' || !state.results) {
        return withNotice(state, ERROR.NOT_READY, 'there is no finished race to rematch');
      }
      if (state.mode === 'multiplayer') {
        return clearNotice(state, {
          screen: 'lobby',
          results: null,
          mp: {
            ...state.mp,
            ready: false,
            players: state.mp.players.map((player) => ({ ...player, ready: false })),
            error: null,
            status: 'rematch: every player must ready again'
          }
        });
      }
      return clearNotice(state, {
        screen: 'loading',
        results: null,
        starts: state.starts + 1,
        loading: {
          ...state.loading,
          status: 'loading',
          error: null,
          startedAt: now,
          attempt: state.loading.attempt + 1
        },
        race: { status: 'loading', config: state.lastConfig, startedAt: now }
      });
    }

    case 'results/exit':
      return clearNotice(state, { screen: 'main-menu', results: null, race: { status: 'idle', config: null, startedAt: null } });

    case 'mp/set-role': {
      if (state.screen !== 'lobby' && state.screen !== 'map-select') return state;
      const role = action.role === 'guest' ? 'guest' : 'host';
      const roomCode = role === 'host' ? '' : state.mp.roomCode;
      return clearNotice(state, {
        mp: {
          ...state.mp,
          role,
          roomCode,
          roomCodeValid: normalizeRoomCode(roomCode) !== null,
          ready: false,
          players: [selfPlayer(state.carSlug, role)]
        }
      });
    }

    case 'mp/set-room-code': {
      if (state.screen !== 'lobby' && state.screen !== 'map-select') return state;
      const raw = String(action.code ?? '').trim().toUpperCase();
      const code = normalizeRoomCode(raw);
      let next = bump(state, {
        mp: { ...state.mp, roomCode: raw, roomCodeValid: code !== null }
      });
      if (!code && action.report !== false) {
        next = withNotice(next, ERROR.ROOM_CODE,
          'room must be 5 characters from ' + ROOM_ALPHABET + ' (got ' + JSON.stringify(raw) + ')');
      }
      return next;
    }

    case 'mp/set-players': {
      if (state.screen !== 'lobby') return state;
      const fallback = selfPlayer(state.carSlug, state.mp.role);
      return clearNotice(state, {
        mp: { ...state.mp, players: normalizePlayers(action.players, fallback) }
      });
    }

    case 'mp/set-ready': {
      if (state.screen !== 'lobby') {
        return withNotice(state, ERROR.NOT_READY, 'ready is only available in the lobby');
      }
      if (!state.mp.verified) {
        return withNotice(state, ERROR.MAP_UNVERIFIED, 'READY needs a verified room map');
      }
      const ready = action.ready === true;
      return clearNotice(state, {
        mp: {
          ...state.mp,
          ready,
          players: state.mp.players.map((player) =>
            player.id === state.mp.youId ? { ...player, ready } : player)
        }
      });
    }

    case 'mp/set-verified': {
      if (state.screen !== 'lobby') return state;
      const verified = action.verified === true;
      return bump(state, {
        mp: {
          ...state.mp,
          verified,
          ready: verified ? state.mp.ready : false,
          players: verified
            ? state.mp.players
            : state.mp.players.map((player) => ({ ...player, ready: false }))
        }
      });
    }

    case 'mp/set-map': {
      if (state.screen !== 'lobby') return state;
      if (state.mp.role !== 'host') {
        return withNotice(state, ERROR.HOST_ONLY, 'only the host selects the map');
      }
      const map = findMap(state, action.mapId);
      if (!map) return withNotice(state, ERROR.UNKNOWN_MAP, 'unknown map ' + JSON.stringify(action.mapId));
      const reason = unsupportedReason(map, 'multiplayer');
      if (reason) return withNotice(state, ERROR.UNSUPPORTED_COMBINATION, reason);
      return clearNotice(state, {
        mapId: map.id,
        mp: {
          ...state.mp,
          mapId: map.id,
          ready: false,
          players: state.mp.players.map((player) => ({ ...player, ready: false })),
          error: null,
          status: 'map changed; readiness cleared'
        }
      });
    }

    case 'mp/set-ai': {
      if (state.screen !== 'lobby') return state;
      if (state.mp.role !== 'host') {
        return withNotice(state, ERROR.HOST_ONLY, 'AI opponents are host-configured');
      }
      const count = Number(action.count);
      if (!Number.isInteger(count) || count < 0 || count > AI_MAX) {
        return withNotice(state, ERROR.AI_COUNT,
          'AI count must be an integer in [0, ' + AI_MAX + '] (got ' + JSON.stringify(action.count) + ')');
      }
      const requestedCars = Array.isArray(action.cars) ? action.cars : [];
      const requestedProfiles = Array.isArray(action.profiles) ? action.profiles : [];
      const rows = [];
      for (let index = 0; index < count; index++) {
        const existing = state.mp.ai.rows[index];
        const requestedCar = requestedCars[index];
        const requestedProfile = requestedProfiles[index];
        const car = requestedCar && findCar(state, requestedCar) ? requestedCar : existing?.car;
        const profile = requestedProfile && AI_PROFILES.includes(requestedProfile)
          ? requestedProfile : existing?.profile;
        rows.push(car || profile
          ? {
            car: car ?? makeAiRow(state.cars, index, state.carSlug).car,
            profile: profile ?? AI_DEFAULT_PROFILES[index] ?? 'standard'
          }
          : makeAiRow(state.cars, index, state.carSlug));
      }
      return clearNotice(state, {
        mp: {
          ...state.mp,
          ai: { count, rows, mapId: state.mp.mapId },
          ready: false,
          players: state.mp.players.map((player) => ({ ...player, ready: false }))
        }
      });
    }

    case 'mp/set-ai-car': {
      if (state.screen !== 'lobby') return state;
      if (state.mp.role !== 'host') return withNotice(state, ERROR.HOST_ONLY, 'AI opponents are host-configured');
      const index = Number(action.index);
      if (!Number.isInteger(index) || index < 0 || index >= state.mp.ai.count) {
        return withNotice(state, ERROR.AI_COUNT, 'AI row ' + action.index + ' does not exist');
      }
      const car = findCar(state, action.slug);
      if (!car) return withNotice(state, ERROR.UNKNOWN_CAR, 'unknown AI car ' + JSON.stringify(action.slug));
      const rows = state.mp.ai.rows.map((row, rowIndex) => rowIndex === index ? { ...row, car: car.slug } : row);
      return clearNotice(state, {
        mp: {
          ...state.mp,
          ai: { ...state.mp.ai, rows },
          ready: false,
          players: state.mp.players.map((player) => ({ ...player, ready: false }))
        }
      });
    }

    case 'mp/set-ai-profile': {
      if (state.screen !== 'lobby') return state;
      if (state.mp.role !== 'host') return withNotice(state, ERROR.HOST_ONLY, 'AI opponents are host-configured');
      const index = Number(action.index);
      if (!Number.isInteger(index) || index < 0 || index >= state.mp.ai.count) {
        return withNotice(state, ERROR.AI_COUNT, 'AI row ' + action.index + ' does not exist');
      }
      if (!AI_PROFILES.includes(action.profile)) {
        return withNotice(state, ERROR.AI_COUNT,
          'aiProfiles must use ' + AI_PROFILES.join(', ') + ' (got ' + action.profile + ')');
      }
      const rows = state.mp.ai.rows.map((row, rowIndex) =>
        rowIndex === index ? { ...row, profile: action.profile } : row);
      return clearNotice(state, {
        mp: {
          ...state.mp,
          ai: { ...state.mp.ai, rows },
          ready: false,
          players: state.mp.players.map((player) => ({ ...player, ready: false }))
        }
      });
    }

    case 'mp/set-powerups': {
      if (state.screen !== 'lobby') return state;
      if (state.mp.role !== 'host') return withNotice(state, ERROR.HOST_ONLY, 'power-ups are host-configured');
      const enabled = action.enabled === true;
      if (enabled && state.mp.mapId !== 'river') {
        const map = findMap(state, state.mp.mapId);
        return withNotice(state, ERROR.POWERUPS_RIVER_ONLY,
          'power-ups are River-only in this gate; ' + (map?.label ?? state.mp.mapId) + ' has no placed pickups');
      }
      return clearNotice(state, {
        mp: {
          ...state.mp,
          powerups: enabled,
          ready: false,
          players: state.mp.players.map((player) => ({ ...player, ready: false }))
        }
      });
    }

    case 'notice':
      return withNotice(state, action.code ?? ERROR.NOT_READY, String(action.message ?? ''));

    case 'notice/clear':
      if (!state.notice) return state;
      return clearNotice(state, {});

    case 'back': {
      if (state.screen === 'lobby') {
        const target = state.mp.role === 'guest' ? 'main-menu' : 'map-select';
        return clearNotice(state, {
          screen: target,
          mp: {
            ...state.mp,
            ready: false,
            players: [selfPlayer(state.carSlug, state.mp.role)],
            error: null,
            status: ''
          }
        });
      }
      if (state.screen === 'loading') {
        return clearNotice(state, {
          screen: state.mode === 'multiplayer' ? 'lobby' : 'map-select',
          loading: { ...state.loading, status: 'idle', error: null, startedAt: null },
          race: { status: 'idle', config: null, startedAt: null }
        });
      }
      if (state.screen === 'race') {
        return clearNotice(state, {
          screen: 'main-menu',
          race: { status: 'idle', config: null, startedAt: null }
        });
      }
      const target = BACK_TARGETS[state.screen];
      if (!target) {
        return withNotice(state, ERROR.NOT_READY, 'there is no previous screen');
      }
      return clearNotice(state, {
        screen: target,
        notice: null,
        ...(state.screen === 'results' ? { results: null } : {})
      });
    }

    default:
      return state;
  }
}

/** URL parameters for each screen. `null` values are removed by `toQuery`. */
export function routeForScreen(state) {
  const route = { shell: '1' };
  switch (state.screen) {
    case 'boot':
      route.screen = 'boot';
      break;
    case 'main-menu':
      break;
    case 'mode-select':
      route.screen = 'mode';
      break;
    case 'car-select':
      route.screen = 'car';
      if (state.mode) route.mode = state.mode;
      break;
    case 'map-select':
      route.screen = 'map';
      if (state.mode) route.mode = state.mode;
      if (state.carSlug) route.car = state.carSlug;
      if (state.mapId) route.map = state.mapId;
      break;
    case 'lobby':
      route.screen = 'lobby';
      route.mode = 'multiplayer';
      route.host = state.mp.role === 'host' ? '1' : '0';
      if (state.mp.roomCode) route.room = state.mp.roomCode;
      if (state.mp.mapId) route.map = state.mp.mapId;
      break;
    case 'loading':
    case 'race':
    case 'results': {
      const config = state.lastConfig ?? buildConfig(state);
      Object.assign(route, engineQueryFor(config));
      if (state.screen !== 'race') route.screen = state.screen;
      break;
    }
    default:
      break;
  }
  return route;
}

/** Canonical e1-drive URL parameters for a start configuration. */
export function engineQueryFor(config) {
  if (!config) return {};
  const query = {};
  if (config.carSlug) query.car = config.carSlug;
  if (config.mapId) query.map = config.mapId;
  if (config.course) query.course = config.course;
  if (config.mode === 'multiplayer' && config.mp) {
    query.mp = '1';
    if (config.mp.role === 'host') query.host = '1';
    else if (config.mp.roomCode) query.room = config.mp.roomCode;
    if (config.mp.aiCount > 0) {
      query.ai = String(config.mp.aiCount);
      query.aiCars = config.mp.aiCars.join(',');
      query.aiProfiles = config.mp.aiProfiles.join(',');
    }
    if (config.mp.powerups) query.powerups = '1';
  }
  return query;
}

export function toQuery(route) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(route ?? {})) {
    if (value === null || value === undefined || value === '') continue;
    params.set(key, String(value));
  }
  return params.toString();
}

/** Roving grid focus for arrow keys. `columns` is the visual column count. */
export function nextGridIndex(index, total, key, columns) {
  if (!Number.isInteger(index) || total <= 0) return 0;
  const columnCount = Math.max(1, Number(columns) || 1);
  if (key === 'ArrowLeft') return Math.max(0, index - 1);
  if (key === 'ArrowRight') return Math.min(total - 1, index + 1);
  if (key === 'ArrowUp') return index - columnCount >= 0 ? index - columnCount : index;
  if (key === 'ArrowDown') {
    const next = index + columnCount;
    return next < total ? next : index;
  }
  if (key === 'Home') return 0;
  if (key === 'End') return total - 1;
  return index;
}

/** Edge-triggered gamepad intent (standard mapping). */
export function gamepadIntent(buttons = [], axes = [], previous = { buttons: [], axes: [] }) {
  const down = (index) => buttons[index] === true || buttons[index]?.pressed === true;
  const was = (index) => previous.buttons?.[index] === true || previous.buttons?.[index]?.pressed === true;
  if (down(1) && !was(1)) return 'back';
  if (down(0) && !was(0)) return 'confirm';
  if (down(12) && !was(12)) return 'up';
  if (down(13) && !was(13)) return 'down';
  if (down(14) && !was(14)) return 'left';
  if (down(15) && !was(15)) return 'right';
  const x = Number(axes[0] ?? 0);
  const y = Number(axes[1] ?? 0);
  const previousX = Number(previous.axes?.[0] ?? 0);
  const previousY = Number(previous.axes?.[1] ?? 0);
  const threshold = 0.5;
  if (y < -threshold && previousY >= -threshold) return 'up';
  if (y > threshold && previousY <= threshold) return 'down';
  if (x < -threshold && previousX >= -threshold) return 'left';
  if (x > threshold && previousX <= threshold) return 'right';
  return null;
}
