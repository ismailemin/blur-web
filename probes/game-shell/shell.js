// Game shell renderer for Blur Web.
//
//   import { mount } from './shell.js';
//   const shell = mount(document.getElementById('game-shell'), {
//     cars: rosterDocument, maps: MAPS, classes, measurements,
//     initial: { screen: 'main-menu' }
//   });
//   shell.on('start', (config) => engine.start(config));
//
// No framework, no bundler, no build step. All decisions live in
// `shell-state.js`; this file only renders and routes DOM events.

import {
  AI_MAX,
  AI_PROFILES,
  CAR_CLASSES,
  DEFAULT_LOADING_TIMEOUT_MS,
  ERROR,
  MATCH_MODE_ORDER,
  MATCH_MODES,
  MODE_ORDER,
  MODES,
  ROOM_ALPHABET,
  SCREEN_STEPS,
  STEP_LABELS,
  activeMapForConfig,
  aiSpawnSupport,
  buildConfig,
  canTransition,
  configSignature,
  courseLabel,
  createShellState,
  currentCar,
  currentMap,
  filterCars,
  formatMetres,
  formatSeconds,
  gamepadIntent,
  mapSupportsMode,
  measuredLength,
  modeLabel,
  nextGridIndex,
  normalizeRoomCode,
  reduce,
  routeForScreen,
  selectionSummary,
  startRejection,
  toQuery,
  unsupportedReason,
  validateAiRows
} from './shell-state.js';

export const SHELL_UI_VERSION = 1;

const FOCUSABLE = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])'
].join(', ');

const DRIVETRAINS = ['all', 'RWD', 'FWD', 'AWD'];
const CLASSES = ['all', ...CAR_CLASSES];
// Must match `.gs-car-grid` at the 1600x900 target in shell.css so arrow-key
// navigation moves by the number of columns the user actually sees.
const CAR_GRID_COLUMNS = 7;
const MAP_GRID_COLUMNS = 3;
const SORTS = [
  ['roster', 'Roster order'],
  ['name', 'Name'],
  ['class', 'Data class'],
  ['mass', 'Mass'],
  ['drivetrain', 'Drivetrain']
];

function h(doc, tag, props = {}, children = []) {
  const element = doc.createElement(tag);
  if (props.class) element.className = props.class;
  if (props.id) element.id = props.id;
  if (props.type) element.setAttribute('type', props.type);
  if (props.role) element.setAttribute('role', props.role);
  if (props.title) element.setAttribute('title', props.title);
  if (props.href) element.setAttribute('href', props.href);
  if (props.for) element.setAttribute('for', props.for);
  if (props.name) element.setAttribute('name', props.name);
  if (props.placeholder) element.setAttribute('placeholder', props.placeholder);
  if (props.autocomplete) element.setAttribute('autocomplete', props.autocomplete);
  if (props.inputmode) element.setAttribute('inputmode', props.inputmode);
  if (props.maxlength !== undefined) element.setAttribute('maxlength', String(props.maxlength));
  if (props.tabindex !== undefined) element.setAttribute('tabindex', String(props.tabindex));
  if (props.hidden) element.hidden = true;
  if (props.disabled) element.disabled = true;
  if (props.checked) element.checked = true;
  if (props.selected) element.selected = true;
  if (props.value !== undefined) element.value = props.value;
  if (props.text !== undefined) element.textContent = String(props.text);
  if (props.attrs) {
    for (const [key, value] of Object.entries(props.attrs)) {
      if (value === null || value === undefined || value === false) continue;
      element.setAttribute(key, value === true ? '' : String(value));
    }
  }
  if (props.dataset) {
    for (const [key, value] of Object.entries(props.dataset)) {
      if (value === null || value === undefined) continue;
      element.dataset[key] = String(value);
    }
  }
  if (props.style) {
    for (const [key, value] of Object.entries(props.style)) {
      if (value !== null && value !== undefined) element.style[key] = value;
    }
  }
  if (props.on) {
    for (const [name, handler] of Object.entries(props.on)) {
      element.addEventListener(name, handler);
    }
  }
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) {
      for (const nested of child) if (nested !== null && nested !== undefined) appendChild(doc, element, nested);
    } else {
      appendChild(doc, element, child);
    }
  }
  return element;
}

function appendChild(doc, element, child) {
  if (child === null || child === undefined || child === false) return;
  if (typeof child === 'string' || typeof child === 'number') {
    element.appendChild(doc.createTextNode(String(child)));
  } else {
    element.appendChild(child);
  }
}

function classBadge(doc, car) {
  const klass = car.carClass;
  return h(doc, 'span', {
    class: 'gs-class gs-class-' + String(klass ?? 'x').toLowerCase(),
    text: klass ?? '?',
    title: klass
      ? 'Vehicle data class ' + klass + ' (content pipeline classification, not a retail race class)'
      : 'Vehicle data class is not recorded',
    attrs: { 'aria-label': klass ? 'Data class ' + klass : 'Data class not recorded' }
  });
}

function carArt(doc) {
  // No car icon art has been decoded for this roster. The tile says so instead
  // of inventing a silhouette or a paint colour.
  return h(doc, 'div', {
    class: 'gs-car-art',
    attrs: { 'aria-hidden': 'true' }
  }, [
    h(doc, 'span', { class: 'gs-car-art-mark', text: '?' }),
    h(doc, 'span', { class: 'gs-car-art-label', text: 'icon not decoded' })
  ]);
}

function selectField(doc, label, value, options, onChange, focusKey, attrs = {}) {
  const id = 'gs-select-' + focusKey;
  const select = h(doc, 'select', {
    id,
    class: 'gs-select',
    value,
    dataset: { focus: focusKey },
    attrs: { 'aria-label': label, ...attrs },
    on: { change: (event) => onChange(event.currentTarget?.value ?? event.target?.value ?? select.value) }
  }, options.map(([optionValue, optionLabel]) =>
    h(doc, 'option', { value: optionValue, text: optionLabel, selected: optionValue === value })));
  return h(doc, 'label', { class: 'gs-field', for: id }, [
    h(doc, 'span', { class: 'gs-field-label', text: label }),
    select
  ]);
}

function chip(doc, text, tone = '') {
  return h(doc, 'span', { class: 'gs-chip' + (tone ? ' gs-chip-' + tone : ''), text });
}

function mapLengthText(map, mode) {
  const direct = measuredLength(map, mode);
  if (direct.kind !== 'missing') return direct.text;
  for (const course of map.courses) {
    const other = measuredLength(map, course);
    if (other.kind !== 'missing') return other.text + ' (' + courseLabel(course) + ')';
  }
  return direct.text;
}

function screenHeading(doc, title, subtitle, eyebrow = null) {
  const heading = h(doc, 'h1', {
    class: 'gs-heading',
    text: title,
    tabindex: -1,
    dataset: { screenHeading: title }
  });
  return h(doc, 'header', { class: 'gs-screen-head' }, [
    eyebrow ? h(doc, 'p', { class: 'gs-eyebrow', text: eyebrow }) : null,
    heading,
    subtitle ? h(doc, 'p', { class: 'gs-subtitle', text: subtitle }) : null
  ]);
}

function noticeBanner(doc, notice, onDismiss) {
  if (!notice) return null;
  return h(doc, 'div', {
    class: 'gs-notice gs-notice-' + (notice.severity ?? 'error'),
    role: 'status',
    dataset: { focus: 'notice' }
  }, [
    h(doc, 'span', { class: 'gs-notice-code', text: notice.code }),
    h(doc, 'span', { class: 'gs-notice-text', text: notice.message }),
    h(doc, 'button', {
      class: 'gs-notice-close',
      type: 'button',
      text: 'DISMISS',
      attrs: { 'aria-label': 'Dismiss message' },
      on: { click: onDismiss }
    })
  ]);
}

export function mount(host, options = {}) {
  if (!host || typeof host.appendChild !== 'function') {
    throw new TypeError('mount(host, options): host must be a DOM element');
  }
  const doc = host.ownerDocument ?? globalThis.document;
  if (!doc) throw new Error('mount(host, options): no document available');

  let state = createShellState(options);
  const listeners = new Map();
  const cleanup = [];
  let destroyed = false;
  let screenChanged = true;
  let activeScreen = null;
  let lastScreen = null;
  let loadingTimer = null;
  let gamepadFrame = null;
  let gamepadPrevious = { buttons: [], axes: [] };
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const reducedMotion = options.reducedMotion === true;
  const syncUrl = options.syncUrl === true;
  const updateTitle = options.updateTitle !== false;

  const root = h(doc, 'div', {
    class: 'gs-app',
    attrs: {
      'data-screen': state.screen,
      'data-reduced-motion': reducedMotion ? 'true' : 'auto',
      'data-shell-version': String(SHELL_UI_VERSION)
    }
  });
  const header = h(doc, 'header', { class: 'gs-header' });
  const rail = h(doc, 'div', { class: 'gs-rail', attrs: { 'aria-label': 'race setup progress' } });
  const scope = h(doc, 'div', { class: 'gs-scope' }, [
    h(doc, 'span', { class: 'gs-scope-dot' }),
    h(doc, 'span', { text: 'SHELL PROTOTYPE' })
  ]);
  const backButton = h(doc, 'button', {
    class: 'gs-back',
    type: 'button',
    text: 'BACK',
    dataset: { focus: 'back' },
    attrs: { 'aria-label': 'Back to the previous screen' },
    on: { click: () => controller.back() }
  });
  header.append(
    h(doc, 'div', { class: 'gs-brand' }, [
      h(doc, 'span', { class: 'gs-brand-name', text: 'BLUR' }),
      h(doc, 'span', { class: 'gs-brand-sub', text: 'WEB / GAME SHELL' })
    ]),
    rail,
    h(doc, 'div', { class: 'gs-header-right' }, [scope, backButton])
  );

  const main = h(doc, 'main', { class: 'gs-main', attrs: { 'aria-label': 'game shell' } });
  const live = h(doc, 'div', {
    class: 'gs-live',
    role: 'status',
    attrs: { 'aria-live': 'polite', 'aria-atomic': 'true' }
  });
  const footerMeta = h(doc, 'span', { class: 'gs-footer-meta', text: 'target 1600x900' });
  const footer = h(doc, 'footer', { class: 'gs-footer' }, [
    h(doc, 'span', { text: 'Arrow keys move  /  Enter selects  /  Esc goes back  /  Tab stays in this screen' }),
    footerMeta
  ]);
  root.append(header, live, main, footer);
  host.appendChild(root);

  function emit(name, payload) {
    const set = listeners.get(name);
    if (!set) return;
    for (const handler of [...set]) handler(payload, state);
  }

  function on(name, handler) {
    if (typeof handler !== 'function') throw new TypeError('on(name, handler): handler must be a function');
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(handler);
    return () => {
      const set = listeners.get(name);
      if (set) set.delete(handler);
    };
  }

  function dispatch(action) {
    if (destroyed) return state;
    const before = state;
    state = reduce(state, { ...action, now: now() });
    if (state === before) return state;
    render();
    if (state.screen !== before.screen) {
      emit('screen', { from: before.screen, to: state.screen, state });
    }
    if (state.notice && state.notice.id !== before.notice?.id) {
      emit('notice', state.notice);
    }
    return state;
  }

  function syncAddress() {
    if (!syncUrl) return;
    const view = doc.defaultView;
    const history = view?.history;
    const location = view?.location;
    if (!history?.replaceState || !location) return;
    const query = toQuery(routeForScreen(state));
    const next = location.pathname + (query ? '?' + query : '');
    if (location.pathname + location.search !== next) {
      history.replaceState(null, '', next);
    }
  }

  function setTitle() {
    if (!updateTitle) return;
    const titles = {
      boot: 'Starting',
      'main-menu': 'Main menu',
      'mode-select': 'Mode select',
      'car-select': 'Car select',
      'map-select': 'Map select',
      lobby: 'Lobby',
      loading: 'Loading',
      race: 'Race',
      results: 'Results'
    };
    try {
      doc.title = 'Blur Web shell - ' + (titles[state.screen] ?? state.screen);
    } catch { /* a test shim may not expose title */ }
  }

  function renderRail() {
    rail.replaceChildren();
    const step = SCREEN_STEPS[state.screen] ?? 0;
    for (let index = 0; index < STEP_LABELS.length; index++) {
      const done = index < step;
      const current = index === step;
      rail.appendChild(h(doc, 'span', {
        class: 'gs-rail-step' + (done ? ' is-done' : '') + (current ? ' is-current' : ''),
        text: String(index + 1) + ' ' + STEP_LABELS[index],
        attrs: current ? { 'aria-current': 'step' } : {}
      }));
    }
  }

  function renderHeader() {
    const canBack = state.screen !== 'boot' && state.screen !== 'main-menu';
    backButton.disabled = !canBack;
    backButton.hidden = !canBack;
    renderRail();
  }

  function focusKeyOf(element) {
    return element?.dataset?.focus ?? null;
  }

  function focusables() {
    if (!activeScreen || typeof activeScreen.querySelectorAll !== 'function') return [];
    return [...activeScreen.querySelectorAll(FOCUSABLE)].filter((element) =>
      element.hidden !== true && element.disabled !== true);
  }

  function focusScreenHeading() {
    const heading = activeScreen?.querySelector('[data-screen-heading]');
    if (heading?.focus) heading.focus();
  }

  function restoreFocus(key, caret) {
    if (!activeScreen || !key) return;
    const escaped = String(key).replace(/"/g, '\\"');
    const element = activeScreen.querySelector('[data-focus="' + escaped + '"]');
    if (!element?.focus) return;
    element.focus();
    if (caret !== null && typeof element.setSelectionRange === 'function' && typeof element.value === 'string') {
      try { element.setSelectionRange(caret, caret); } catch { /* inputs without selection */ }
    }
  }

  function render() {
    if (destroyed) return;
    const focused = doc.activeElement;
    const key = focusKeyOf(focused);
    const caret = typeof focused?.selectionStart === 'number' ? focused.selectionStart : null;
    const wasScreen = lastScreen;
    lastScreen = state.screen;
    screenChanged = wasScreen !== state.screen;

    root.dataset.screen = state.screen;
    renderHeader();
    live.textContent = noticeText();
    footerMeta.textContent = 'target 1600x900  /  ' + (state.cars.length && state.maps.length
      ? state.cars.length + ' cars  /  ' + state.maps.length + ' maps'
      : 'reading committed data');

    let screen = null;
    switch (state.screen) {
      case 'boot': screen = renderBoot(); break;
      case 'main-menu': screen = renderMainMenu(); break;
      case 'mode-select': screen = renderModeSelect(); break;
      case 'car-select': screen = renderCarSelect(); break;
      case 'map-select': screen = renderMapSelect(); break;
      case 'lobby': screen = renderLobby(); break;
      case 'loading': screen = renderLoading(); break;
      case 'race': screen = renderRace(); break;
      case 'results': screen = renderResults(); break;
      default: screen = h(doc, 'section', { class: 'gs-screen' }, [
        h(doc, 'p', { text: 'Unknown screen ' + state.screen })
      ]);
    }
    activeScreen = screen;
    main.replaceChildren(screen);
    if (screenChanged) focusScreenHeading();
    else restoreFocus(key, caret);
    syncAddress();
    setTitle();
  }

  function noticeText() {
    if (state.notice) return state.notice.code + ': ' + state.notice.message;
    const titles = {
      boot: 'Starting the shell',
      'main-menu': 'Main menu',
      'mode-select': 'Choose a mode',
      'car-select': 'Choose a car',
      'map-select': 'Choose a map',
      lobby: 'Multiplayer lobby',
      loading: 'Loading the race',
      race: 'Race running',
      results: 'Race results'
    };
    return titles[state.screen] ?? state.screen;
  }

  // ---------------------------------------------------------------- screens

  function renderBoot() {
    const section = h(doc, 'section', { class: 'gs-screen gs-screen-boot' });
    section.appendChild(screenHeading(doc, 'BLUR WEB', 'Game shell boot', 'FRONT END'));
    if (state.boot.status === 'error') {
      section.appendChild(h(doc, 'div', { class: 'gs-panel gs-panel-error', role: 'alert' }, [
        h(doc, 'p', { class: 'gs-error-code', text: state.boot.error?.code ?? ERROR.BOOT_FAILED }),
        h(doc, 'p', { class: 'gs-error-text', text: state.boot.error?.message ?? 'shell boot failed' }),
        h(doc, 'button', {
          class: 'gs-button',
          type: 'button',
          text: 'RETRY BOOT',
          dataset: { focus: 'boot-retry' },
          on: { click: () => controller.bootReady() }
        })
      ]));
      return section;
    }
    section.appendChild(h(doc, 'div', { class: 'gs-boot' }, [
      h(doc, 'div', { class: 'gs-spinner', attrs: { 'aria-hidden': 'true' } }),
      h(doc, 'p', { text: 'Reading the committed car roster, map registry and measurements…' })
    ]));
    return section;
  }

  function renderMainMenu() {
    const section = h(doc, 'section', { class: 'gs-screen gs-screen-menu' });
    section.appendChild(h(doc, 'div', { class: 'gs-hero' }, [
      h(doc, 'p', { class: 'gs-eyebrow', text: 'BLUR WEB / PLAYABLE SLICES' }),
      h(doc, 'h1', { class: 'gs-hero-title', text: 'PICK A RACE.', tabindex: -1, dataset: { screenHeading: 'Main menu' } }),
      h(doc, 'p', { class: 'gs-hero-lead', text: 'The E1 drive page used to open one URL-selected corridor. This shell adds a real front end: mode, car, map, lobby, loading, race and results.' }),
      h(doc, 'div', { class: 'gs-hero-actions' }, [
        h(doc, 'button', {
          class: 'gs-button gs-button-primary gs-button-large',
          type: 'button',
          text: 'PLAY',
          dataset: { focus: 'play' },
          on: { click: () => dispatch({ type: 'menu/play' }) }
        })
      ]),
      h(doc, 'p', { class: 'gs-hint', text: 'The shell is data-complete: every roster car and every registered map is listed. The driving engine is not mounted in this standalone demo.' })
    ]));
    const counts = {
      cars: state.cars.length,
      maps: state.maps.length,
      modes: MODE_ORDER.length,
      classes: new Set(state.cars.map((car) => car.carClass)).size
    };
    section.appendChild(h(doc, 'div', { class: 'gs-stat-row' }, [
      statCard(doc, String(counts.cars), 'roster cars'),
      statCard(doc, String(counts.maps), 'maps'),
      statCard(doc, String(counts.modes), 'modes'),
      statCard(doc, String(counts.classes), 'data classes')
    ]));
    section.appendChild(h(doc, 'div', { class: 'gs-panel gs-menu-note' }, [
      h(doc, 'h2', { class: 'gs-panel-title', text: 'WHAT THIS SCREEN IS' }),
      h(doc, 'p', { text: 'A shell-only preview. The car grid has no decoded icon art and says so on every tile. The ' + state.maps.length + ' maps are the real registry entries with their measured lengths and course lists. No engine frame, no game capture and no retail claim is made here.' })
    ]));
    return section;
  }

  function statCard(doc, value, label) {
    return h(doc, 'div', { class: 'gs-stat' }, [
      h(doc, 'strong', { text: value }),
      h(doc, 'span', { text: label })
    ]);
  }

  function renderModeSelect() {
    const section = h(doc, 'section', { class: 'gs-screen gs-screen-modes' });
    section.appendChild(screenHeading(doc, 'Choose a mode', 'Each mode maps to a measured course. Maps that do not provide that course stay visible and disabled with the reason.', 'STEP 1 / 4'));
    appendChild(doc, section, noticeBanner(doc, state.notice, () => dispatch({ type: 'notice/clear' })));
    const grid = h(doc, 'div', {
      class: 'gs-mode-grid',
      dataset: { grid: 'modes', gridColumns: '2' },
      attrs: { 'aria-label': 'game modes' }
    });
    MODE_ORDER.forEach((modeId, index) => {
      const mode = MODES[modeId];
      const supportedMaps = state.maps.filter((map) => mapSupportsMode(map, modeId)).length;
      grid.appendChild(h(doc, 'button', {
        class: 'gs-mode-card' + (state.mode === modeId ? ' is-selected' : ''),
        type: 'button',
        dataset: { focus: 'mode-' + modeId, grid: 'modes', gridIndex: index, gridColumns: 2 },
        attrs: { 'aria-pressed': state.mode === modeId ? 'true' : 'false' },
        on: { click: () => controller.selectMode(modeId) }
      }, [
        h(doc, 'span', { class: 'gs-mode-index', text: '0' + (index + 1) }),
        h(doc, 'span', { class: 'gs-mode-name', text: mode.label }),
        h(doc, 'span', { class: 'gs-mode-tag', text: mode.tagline }),
        h(doc, 'span', { class: 'gs-mode-desc', text: mode.description }),
        h(doc, 'span', { class: 'gs-mode-meta' }, [
          chip(doc, courseLabel(mode.course)),
          chip(doc, supportedMaps + ' of ' + state.maps.length + ' maps')
        ])
      ]));
    });
    section.appendChild(grid);
    section.appendChild(h(doc, 'p', { class: 'gs-footnote', text: 'Sprint and multiplayer use each map\'s measured 310 m point-to-point course. 3-Lap needs a measured loop (River loop-01, Amboy loop-01). Free Roam needs the River basin. A map without the requested course stays visible and disabled with the reason.' }));
    return section;
  }

  function renderCarSelect() {
    const section = h(doc, 'section', { class: 'gs-screen gs-screen-cars' });
    section.appendChild(screenHeading(doc, 'Choose a car', 'All ' + state.cars.length + ' committed roster cars. Filtering and sorting never change the roster data.', 'STEP 2 / 4'));
    appendChild(doc, section, noticeBanner(doc, state.notice, () => dispatch({ type: 'notice/clear' })));

    const filters = state.filters;
    const toolbar = h(doc, 'div', { class: 'gs-toolbar' }, [
      h(doc, 'label', { class: 'gs-field gs-field-search' }, [
        h(doc, 'span', { class: 'gs-field-label', text: 'Search' }),
        h(doc, 'input', {
          class: 'gs-input',
          type: 'search',
          value: filters.query,
          placeholder: 'name, slug or layout',
          autocomplete: 'off',
          dataset: { focus: 'car-search' },
          attrs: { 'aria-label': 'Search cars by name, slug or layout' },
          on: {
            input: (event) => dispatch({ type: 'filters/set', patch: { query: event.target.value } })
          }
        })
      ]),
      selectField(doc, 'Data class', filters.carClass, CLASSES.map((value) => [value,
        value === 'all' ? 'All classes' : value === 'unclassified' ? 'Unclassified' : 'Class ' + value]),
        (value) => dispatch({ type: 'filters/set', patch: { carClass: value } }), 'car-class'),
      selectField(doc, 'Drivetrain', filters.drivetrain, DRIVETRAINS.map((value) => [value, value === 'all' ? 'All drivetrains' : value]),
        (value) => dispatch({ type: 'filters/set', patch: { drivetrain: value } }), 'car-drivetrain'),
      selectField(doc, 'Sort', filters.sort, SORTS,
        (value) => dispatch({ type: 'filters/set', patch: { sort: value } }), 'car-sort')
    ]);
    section.appendChild(toolbar);

    const cars = filterCars(state.cars, filters);
    section.appendChild(h(doc, 'div', { class: 'gs-result-row' }, [
      h(doc, 'span', { text: 'SHOWING ' + cars.length + ' OF ' + state.cars.length }),
      cars.length !== state.cars.length
        ? h(doc, 'button', {
          class: 'gs-link',
          type: 'button',
          text: 'CLEAR FILTERS',
          dataset: { focus: 'car-clear' },
          on: { click: () => dispatch({ type: 'filters/set', patch: { query: '', carClass: 'all', drivetrain: 'all' } }) }
        })
        : null
    ]));

    if (!cars.length) {
      section.appendChild(h(doc, 'div', { class: 'gs-empty' }, [
        h(doc, 'p', { text: 'No roster car matches this filter.' }),
        h(doc, 'p', { class: 'gs-hint', text: 'The filter is local; the roster itself still has ' + state.cars.length + ' cars.' })
      ]));
    } else {
      const grid = h(doc, 'div', {
        class: 'gs-car-grid',
        dataset: { grid: 'cars', gridColumns: String(CAR_GRID_COLUMNS) },
        attrs: { 'aria-label': 'roster cars' }
      });
      cars.forEach((car, index) => {
        const selected = car.slug === state.carSlug;
        grid.appendChild(h(doc, 'button', {
          class: 'gs-car-tile' + (selected ? ' is-selected' : ''),
          type: 'button',
          dataset: {
            focus: 'car-' + car.slug,
            carSlug: car.slug,
            grid: 'cars',
            gridIndex: index,
            gridColumns: String(CAR_GRID_COLUMNS)
          },
          attrs: {
            'aria-pressed': selected ? 'true' : 'false',
            'aria-label': car.name + ', data class ' + (car.carClass ?? 'not recorded') + ', ' +
              (car.drivetrain ?? 'drivetrain not recorded') + ', ' +
              (car.massKg === null ? 'mass not recorded' : car.massKg + ' kilograms') + ', ' +
              (car.gearbox ?? 'gearbox not recorded')
          },
          on: { click: () => controller.selectCar(car.slug) }
        }, [
          carArt(doc),
          h(doc, 'span', { class: 'gs-car-head' }, [
            classBadge(doc, car),
            h(doc, 'span', { class: 'gs-car-name', text: car.name })
          ]),
          h(doc, 'span', { class: 'gs-car-slug', text: car.slug }),
          h(doc, 'span', { class: 'gs-car-meta', text: [
            car.drivetrain ?? 'drivetrain ?',
            car.massKg === null ? 'mass ?' : car.massKg + ' kg',
            car.gearbox ?? 'gearbox ?'
          ].join('  /  ') }),
          h(doc, 'span', { class: 'gs-car-record', text: 'record ' + (car.recordIndex ?? '?') + '  /  id ' + (car.recordId ?? '?') })
        ]));
      });
      section.appendChild(grid);
    }

    const selectedCar = currentCar(state);
    section.appendChild(h(doc, 'div', { class: 'gs-action-row' }, [
      h(doc, 'div', { class: 'gs-selected' }, [
        h(doc, 'span', { class: 'gs-selected-label', text: 'SELECTED' }),
        h(doc, 'strong', { text: selectedCar?.name ?? 'none' }),
        h(doc, 'span', { class: 'gs-hint', text: selectedCar
          ? selectedCar.drivetrain + ' / ' + selectedCar.massKg + ' kg / ' + selectedCar.gearbox + ' / data class ' + selectedCar.carClass
          : 'pick a car from the grid' })
      ]),
      h(doc, 'button', {
        class: 'gs-button gs-button-primary',
        type: 'button',
        text: 'CONTINUE TO MAP',
        disabled: !selectedCar,
        dataset: { focus: 'car-next' },
        on: { click: () => controller.confirmCar() }
      })
    ]));
    return section;
  }

  function renderMapSelect() {
    const section = h(doc, 'section', { class: 'gs-screen gs-screen-maps' });
    const mode = state.mode;
    section.appendChild(screenHeading(doc, 'Choose a map',
      mode ? modeLabel(mode) + ' / ' + courseLabel(MODES[mode].course) + '. Unsupported map/mode pairs are disabled with a visible reason.' : 'Choose a mode first.',
      'STEP 3 / 4'));
    appendChild(doc, section, noticeBanner(doc, state.notice, () => dispatch({ type: 'notice/clear' })));

    if (mode === 'multiplayer') section.appendChild(renderRolePanel());

    const grid = h(doc, 'div', {
      class: 'gs-map-grid',
      dataset: { grid: 'maps', gridColumns: String(MAP_GRID_COLUMNS) },
      attrs: { 'aria-label': 'maps' }
    });
    state.maps.forEach((map, index) => {
      const reason = unsupportedReason(map, mode);
      const supported = reason === null;
      const selected = map.id === state.mapId;
      const lengthText = mapLengthText(map, mode);
      const reasonId = 'gs-map-reason-' + map.id;
      const card = h(doc, 'button', {
        class: 'gs-map-card' + (selected ? ' is-selected' : '') + (supported ? '' : ' is-disabled'),
        type: 'button',
        disabled: !supported,
        dataset: { focus: 'map-' + map.id, grid: 'maps', gridIndex: index, gridColumns: String(MAP_GRID_COLUMNS) },
        attrs: {
          'aria-pressed': selected ? 'true' : 'false',
          'aria-describedby': reason ? reasonId : null
        },
        on: { click: () => controller.selectMap(map.id) }
      }, [
        h(doc, 'span', { class: 'gs-map-top' }, [
          h(doc, 'span', { class: 'gs-map-label', text: map.label }),
          h(doc, 'span', { class: 'gs-map-id', text: map.id })
        ]),
        h(doc, 'span', { class: 'gs-map-level', text: map.level ?? 'level not recorded' }),
        h(doc, 'span', { class: 'gs-map-length', text: lengthText }),
        h(doc, 'span', { class: 'gs-map-kind', text: map.kind === 'map-package' ? 'map package' : 'single map' }),
        h(doc, 'span', { class: 'gs-map-courses' }, map.courses.map((course) => chip(doc, courseLabel(course),
          mapSupportsMode(map, mode) && course === MODES[mode]?.course ? 'on' : '')))
      ]);
      grid.appendChild(h(doc, 'div', { class: 'gs-map-item' }, [
        card,
        reason ? h(doc, 'p', {
          class: 'gs-disabled-reason',
          id: reasonId,
          text: 'Unavailable: ' + reason,
          dataset: { reasonFor: map.id }
        }) : null
      ]));
    });
    section.appendChild(grid);

    if (mode === 'multiplayer') {
      section.appendChild(renderMpRoleSummary());
    }

    const map = currentMap(state);
    const reason = mode && map ? unsupportedReason(map, mode) : (map ? 'select a mode first' : 'select a map first');
    const gate = startRejection(state);
    const actionLabel = mode === 'multiplayer' ? 'OPEN LOBBY' : 'START RACE';
    const actionDisabled = mode === 'multiplayer' ? reason !== null : !gate.ok;
    section.appendChild(h(doc, 'div', { class: 'gs-action-row' }, [
      h(doc, 'div', { class: 'gs-selected' }, [
        h(doc, 'span', { class: 'gs-selected-label', text: mode === 'multiplayer' ? 'LOBBY' : 'READY' }),
        h(doc, 'strong', { text: selectionSummary(state) }),
        h(doc, 'span', { class: 'gs-hint', text: reason ?? 'All selections are supported by the map registry.' })
      ]),
      h(doc, 'button', {
        class: 'gs-button gs-button-primary',
        type: 'button',
        text: actionLabel,
        disabled: actionDisabled,
        dataset: { focus: 'map-action' },
        attrs: { 'aria-describedby': reason ? 'gs-map-action-reason' : null },
        on: {
          click: () => {
            if (mode === 'multiplayer') controller.openLobby();
            else controller.start();
          }
        }
      })
    ]));
    if (actionDisabled && reason) {
      section.appendChild(h(doc, 'p', { class: 'gs-disabled-reason', id: 'gs-map-action-reason', text: 'Unavailable: ' + reason }));
    }
    return section;
  }

  function renderRolePanel() {
    const panel = h(doc, 'div', { class: 'gs-panel gs-role-panel' }, [
      h(doc, 'h2', { class: 'gs-panel-title', text: 'ONLINE ROLE' }),
      h(doc, 'div', { class: 'gs-role-toggle', role: 'group', attrs: { 'aria-label': 'online role' } }, [
        h(doc, 'button', {
          class: 'gs-button' + (state.mp.role === 'host' ? ' is-selected' : ''),
          type: 'button',
          text: 'HOST',
          dataset: { focus: 'role-host' },
          attrs: { 'aria-pressed': state.mp.role === 'host' ? 'true' : 'false' },
          on: { click: () => dispatch({ type: 'mp/set-role', role: 'host' }) }
        }),
        h(doc, 'button', {
          class: 'gs-button' + (state.mp.role === 'guest' ? ' is-selected' : ''),
          type: 'button',
          text: 'GUEST',
          dataset: { focus: 'role-guest' },
          attrs: { 'aria-pressed': state.mp.role === 'guest' ? 'true' : 'false' },
          on: { click: () => dispatch({ type: 'mp/set-role', role: 'guest' }) }
        })
      ])
    ]);
    if (state.mp.role === 'guest') {
      const valid = normalizeRoomCode(state.mp.roomCode) !== null;
      panel.appendChild(h(doc, 'label', { class: 'gs-field', for: 'gs-room-code' }, [
        h(doc, 'span', { class: 'gs-field-label', text: 'Room code' }),
        h(doc, 'input', {
          id: 'gs-room-code',
          class: 'gs-input gs-room-input',
          type: 'text',
          value: state.mp.roomCode,
          placeholder: '5 characters',
          maxlength: 5,
          autocomplete: 'off',
          inputmode: 'latin',
          dataset: { focus: 'room-code' },
          attrs: { 'aria-label': 'Room code', 'aria-invalid': valid ? 'false' : 'true' },
          on: {
            input: (event) => dispatch({ type: 'mp/set-room-code', code: event.target.value, report: false })
          }
        })
      ]));
      panel.appendChild(h(doc, 'p', {
        class: 'gs-field-note' + (valid ? '' : ' is-invalid'),
        text: valid
          ? 'Joining room ' + normalizeRoomCode(state.mp.roomCode)
          : 'Room codes use ' + ROOM_ALPHABET + ' (5 characters).'
      }));
    } else {
      panel.appendChild(h(doc, 'p', { class: 'gs-field-note', text: state.mp.roomCode
        ? 'Demo room code ' + state.mp.roomCode + ' (a live room service allocates the real code).'
        : 'The room service allocates the code when the host connects; this standalone shell has no socket.' }));
    }
    return panel;
  }

  function renderMpRoleSummary() {
    return h(doc, 'p', { class: 'gs-footnote', text: state.mp.role === 'host'
      ? 'Host: you create the room, choose the map and may add 0-3 AI opponents. A solo host can start only with at least one AI.'
      : 'Guest: you inherit the host map and AI list. The host starts the race.' });
  }

  function renderLobby() {
    const section = h(doc, 'section', { class: 'gs-screen gs-screen-lobby' });
    section.appendChild(screenHeading(doc, 'Lobby', 'Host-authoritative room. Readiness and the start gate use the existing M1/AI rules.', 'STEP 4 / 4'));
    appendChild(doc, section, noticeBanner(doc, state.notice, () => dispatch({ type: 'notice/clear' })));

    const map = activeMapForConfig(state);
    section.appendChild(h(doc, 'div', { class: 'gs-lobby-banner' }, [
      h(doc, 'div', { class: 'gs-room' }, [
        h(doc, 'span', { class: 'gs-room-label', text: 'ROOM' }),
        h(doc, 'strong', { class: 'gs-room-code', text: state.mp.roomCode || 'ALLOCATED ON CONNECT' }),
        h(doc, 'span', { class: 'gs-room-role', text: state.mp.role.toUpperCase() })
      ]),
      h(doc, 'div', { class: 'gs-lobby-facts' }, [
        h(doc, 'span', { text: 'MAP ' + (map?.label ?? 'none') + ' / ' + (map?.level ?? '') }),
        h(doc, 'span', { text: state.mp.verified ? 'map hash agreement: verified' : 'map hash agreement: NOT VERIFIED' }),
        h(doc, 'span', { text: 'AI ' + state.mp.ai.count + ' / ' + AI_MAX + '  /  power-ups ' + (state.mp.powerups ? 'on' : 'off') })
      ])
    ]));

    if (options.demo === true) {
      section.appendChild(h(doc, 'div', { class: 'gs-demo-strip' }, [
        h(doc, 'span', { text: 'DEMO CONTROL' }),
        h(doc, 'button', {
          class: 'gs-link',
          type: 'button',
          text: state.mp.verified ? 'mark map unverified' : 'mark map verified',
          dataset: { focus: 'demo-verify' },
          on: { click: () => controller.setMpVerified(!state.mp.verified) }
        })
      ]));
    }

    // Players
    const players = [...state.mp.players];
    if (players.length < 2) {
      players.push({
        id: 'waiting',
        name: state.mp.ai.count > 0 ? 'AI covers the second slot' : 'Waiting for a second player',
        host: false,
        ready: false,
        connected: false,
        placeholder: true
      });
    }
    const playersPanel = h(doc, 'div', { class: 'gs-panel gs-players' }, [
      h(doc, 'h2', { class: 'gs-panel-title', text: 'PLAYERS' }),
      ...players.map((player) => h(doc, 'div', {
        class: 'gs-player' + (player.placeholder ? ' is-placeholder' : ''),
        dataset: { playerId: player.id }
      }, [
        h(doc, 'span', { class: 'gs-player-name', text: player.name }),
        h(doc, 'span', { class: 'gs-player-tag', text: player.ai ? 'AI' : player.host ? 'HOST' : 'GUEST' }),
        h(doc, 'span', {
          class: 'gs-player-ready' + (player.ready ? ' is-ready' : ''),
          text: player.placeholder ? '—' : player.ready ? 'READY' : 'NOT READY'
        }),
        h(doc, 'span', { class: 'gs-player-car', text: player.car ?? '' })
      ]))
    ]);

    // Ready
    const self = state.mp.players.find((player) => player.id === state.mp.youId) ?? state.mp.players[0];
    const readyReason = state.mp.verified ? null : 'READY needs a verified room map';
    const readyRow = h(doc, 'div', { class: 'gs-ready-row' }, [
      h(doc, 'button', {
        class: 'gs-button' + (self?.ready ? ' gs-button-primary' : ''),
        type: 'button',
        text: self?.ready ? 'READY ✓' : 'READY',
        disabled: Boolean(readyReason),
        dataset: { focus: 'ready' },
        on: { click: () => controller.setReady(!(self?.ready === true)) }
      }),
      h(doc, 'span', { class: 'gs-hint', text: readyReason ?? 'Readiness is per human player. AI opponents are host-simulated and do not ready up.' })
    ]);

    // Power-ups
    // Every map runs the slice: the three maps with retail placement (River,
    // Amboy, Gracia) use it, the rest fall back to the labelled provisional
    // arcs. Only the host configures it.
    const powerupReason = state.mp.role !== 'host'
      ? 'power-ups are host-configured'
      : null;
    const powerupRow = h(doc, 'div', { class: 'gs-toggle-row' }, [
      h(doc, 'label', { class: 'gs-check' }, [
        h(doc, 'input', {
          type: 'checkbox',
          checked: state.mp.powerups,
          disabled: Boolean(powerupReason),
          dataset: { focus: 'powerups' },
          on: { change: (event) => controller.setPowerups(event.target.checked) }
        }),
        h(doc, 'span', { text: 'Power-ups (Bomb / Shield / Repair / Nitro / Shock / Blindfire / Shunt / Barge / SuperShield)' })
      ]),
      powerupReason ? h(doc, 'span', { class: 'gs-field-note is-invalid', text: powerupReason }) : null
    ]);

    // Match mode: Race (measured sprint) or Destruction (Motor Mash). Both are
    // committed retail modes; Destruction forces the power-up slice because its
    // score comes from wrecks.
    const matchModeReason = state.mp.role !== 'host' ? 'the match mode is host-configured' : null;
    const matchModeRow = h(doc, 'div', { class: 'gs-toggle-row' }, [
      h(doc, 'span', { class: 'gs-field-label', text: 'Match mode' }),
      h(doc, 'div', { class: 'gs-segmented', dataset: { focus: 'match-mode' } },
        MATCH_MODE_ORDER.map((id) => h(doc, 'button', {
          type: 'button',
          class: 'gs-segment' + (state.mp.matchMode === id ? ' is-active' : ''),
          text: MATCH_MODES[id].label,
          disabled: Boolean(matchModeReason),
          dataset: { focus: 'match-mode-' + id, matchMode: id },
          on: { click: () => controller.setMatchMode(id) }
        }))),
      h(doc, 'span', {
        class: 'gs-field-note',
        text: MATCH_MODES[state.mp.matchMode]?.tagline ?? ''
      }),
      matchModeReason ? h(doc, 'span', { class: 'gs-field-note is-invalid', text: matchModeReason }) : null
    ]);

    section.appendChild(h(doc, 'div', { class: 'gs-lobby-grid' }, [
      h(doc, 'div', { class: 'gs-lobby-col' }, [playersPanel, readyRow, matchModeRow, powerupRow]),
      h(doc, 'div', { class: 'gs-lobby-col' }, [renderAiPanel(), renderLobbyMapPanel()])
    ]));

    // Start
    const gate = startRejection(state);
    const startReason = gate.ok ? null : gate.reason;
    section.appendChild(h(doc, 'div', { class: 'gs-start-panel' }, [
      h(doc, 'button', {
        class: 'gs-button gs-button-primary gs-button-large',
        type: 'button',
        text: 'START RACE',
        disabled: !gate.ok,
        dataset: { focus: 'start' },
        attrs: { 'aria-describedby': startReason ? 'gs-start-reason' : null },
        on: { click: () => controller.start() }
      }),
      h(doc, 'p', {
        class: 'gs-start-reason' + (gate.ok ? ' is-ok' : ''),
        id: 'gs-start-reason',
        text: gate.ok ? 'All start conditions pass.' : startReason
      })
    ]));
    return section;
  }

  function renderAiPanel() {
    const host = state.mp.role === 'host';
    const panel = h(doc, 'div', { class: 'gs-panel gs-ai' }, [
      h(doc, 'h2', { class: 'gs-panel-title', text: 'AI OPPONENTS (HOST ONLY)' }),
      h(doc, 'div', { class: 'gs-ai-toolbar' }, [
        selectField(doc, 'AI count', String(state.mp.ai.count),
          Array.from({ length: AI_MAX + 1 }, (_, value) => [String(value), String(value)]),
          (value) => controller.setAi({ count: Number(value) }),
          'ai-count',
          { disabled: !host })
      ]),
      h(doc, 'p', { class: 'gs-hint', text: host
        ? '0-3 host-simulated cars. A solo host needs at least one AI to start. Each AI has its own car and skill profile.'
        : 'Guests see the AI list read-only; the host owns count, cars and profiles.' })
    ]);
    for (let index = 0; index < state.mp.ai.count; index++) {
      const row = state.mp.ai.rows[index] ?? {};
      const car = state.cars.find((entry) => entry.slug === row.car) ?? null;
      const support = aiSpawnSupport(state.mp.mapId, row.car);
      const rowReasonId = 'gs-ai-reason-' + index;
      panel.appendChild(h(doc, 'div', {
        class: 'gs-ai-row' + (support.ok ? '' : ' is-invalid'),
        dataset: { aiRow: index }
      }, [
        h(doc, 'span', { class: 'gs-ai-name', text: 'AI ' + (index + 1) }),
        selectField(doc, 'Car', row.car ?? '', state.cars.map((entry) => [entry.slug, entry.name]),
          (value) => controller.setAiCar(index, value), 'ai-car-' + index, {
            disabled: !host,
            'aria-describedby': support.ok ? null : rowReasonId
          }),
        selectField(doc, 'Profile', row.profile, AI_PROFILES.map((value) => [value, value]),
          (value) => controller.setAiProfile(index, value), 'ai-profile-' + index, { disabled: !host }),
        support.ok ? null : h(doc, 'p', {
          class: 'gs-field-note is-invalid',
          id: rowReasonId,
          text: support.code + ': ' + support.reason
        }),
        h(doc, 'span', { class: 'gs-ai-speed', text: car ? 'speed x' + (row.profile === 'cautious' ? '0.85' : row.profile === 'reference' ? '1.00' : '0.95') : '' })
      ]));
    }
    const validation = validateAiRows(state);
    if (!validation.ok) {
      panel.appendChild(h(doc, 'p', { class: 'gs-field-note is-invalid', text: validation.errors.join('; ') }));
    }
    return panel;
  }

  function renderLobbyMapPanel() {
    const host = state.mp.role === 'host';
    const panel = h(doc, 'div', { class: 'gs-panel gs-lobby-maps' }, [
      h(doc, 'h2', { class: 'gs-panel-title', text: 'ROOM MAP' }),
      h(doc, 'p', { class: 'gs-hint', text: host
        ? 'Host-only. Changing the map clears every ready flag and re-runs hash agreement before READY.'
        : 'Only the host selects the map; the guest inherits the room map.' })
    ]);
    const row = h(doc, 'div', {
      class: 'gs-map-row',
      dataset: { grid: 'lobby-maps', gridColumns: '3' },
      attrs: { 'aria-label': 'room map' }
    });
    state.maps.forEach((map, index) => {
      const reason = unsupportedReason(map, 'multiplayer');
      const disabled = !host || reason !== null;
      const selected = map.id === state.mp.mapId;
      row.appendChild(h(doc, 'button', {
        class: 'gs-map-pill' + (selected ? ' is-selected' : ''),
        type: 'button',
        disabled,
        dataset: { focus: 'lobby-map-' + map.id, grid: 'lobby-maps', gridIndex: index, gridColumns: 3 },
        attrs: {
          'aria-pressed': selected ? 'true' : 'false',
          'aria-label': map.label + (reason ? ': ' + reason : '')
        },
        on: { click: () => controller.setMpMap(map.id) }
      }, [
        h(doc, 'span', { class: 'gs-map-pill-label', text: map.label }),
        h(doc, 'span', { class: 'gs-map-pill-length', text: measuredLength(map, 'multiplayer').text })
      ]));
      if (reason) {
        row.appendChild(h(doc, 'span', { class: 'gs-field-note is-invalid', text: 'Unavailable: ' + reason }));
      }
    });
    panel.appendChild(row);
    if (!host) panel.appendChild(h(doc, 'p', { class: 'gs-field-note', text: 'Map selector disabled: only the host selects the map.' }));
    return panel;
  }

  function renderLoading() {
    const config = state.lastConfig;
    const section = h(doc, 'section', { class: 'gs-screen gs-screen-loading' });
    section.appendChild(screenHeading(doc, 'Loading race', config
      ? modeLabel(config.mode) + ' / ' + (config.mapLabel ?? config.mapId) + ' / ' + (config.carName ?? config.carSlug)
      : 'No race configuration', 'STEP 5 / 6'));
    appendChild(doc, section, noticeBanner(doc, state.notice, () => dispatch({ type: 'notice/clear' })));
    if (state.loading.error) {
      section.appendChild(h(doc, 'div', { class: 'gs-panel gs-panel-error', role: 'alert' }, [
        h(doc, 'p', { class: 'gs-error-code', text: state.loading.error.code }),
        h(doc, 'p', { class: 'gs-error-text', text: state.loading.error.message }),
        h(doc, 'div', { class: 'gs-action-row' }, [
          h(doc, 'button', {
            class: 'gs-button gs-button-primary',
            type: 'button',
            text: 'RETRY LOAD',
            dataset: { focus: 'loading-retry' },
            on: { click: () => controller.retryLoading() }
          }),
          h(doc, 'button', {
            class: 'gs-button',
            type: 'button',
            text: 'BACK',
            dataset: { focus: 'loading-back' },
            on: { click: () => controller.back() }
          })
        ])
      ]));
      section.appendChild(h(doc, 'p', { class: 'gs-footnote', text: 'The typed error stays on screen. The shell never falls back to a different map or mode.' }));
      return section;
    }
    section.appendChild(h(doc, 'div', { class: 'gs-loading' }, [
      h(doc, 'div', { class: 'gs-spinner', attrs: { 'aria-hidden': 'true' } }),
      h(doc, 'div', { class: 'gs-loading-copy' }, [
        h(doc, 'p', { class: 'gs-loading-title', text: 'WAITING FOR THE ENGINE' }),
        h(doc, 'p', { class: 'gs-hint', text: 'Attempt ' + state.loading.attempt + ' / timeout ' + state.loading.timeoutMs + ' ms. The integration calls raceReady() when the wasm world and map hashes are ready.' })
      ])
    ]));
    section.appendChild(h(doc, 'div', { class: 'gs-action-row' }, [
      h(doc, 'button', {
        class: 'gs-button',
        type: 'button',
        text: 'CANCEL',
        dataset: { focus: 'loading-cancel' },
        on: { click: () => controller.back() }
      })
    ]));
    return section;
  }

  function renderRace() {
    const config = state.race.config ?? state.lastConfig;
    const section = h(doc, 'section', { class: 'gs-screen gs-screen-race' + (options.integrated ? ' is-integrated' : '') });
    if (options.integrated) {
      section.appendChild(h(doc, 'div', { class: 'gs-race-bar' }, [
        h(doc, 'strong', { text: 'RACE' }),
        h(doc, 'span', { text: config ? (config.mapLabel ?? config.mapId) + ' / ' + (config.carName ?? config.carSlug) : '' }),
        h(doc, 'button', {
          class: 'gs-link',
          type: 'button',
          text: 'QUIT (ESC)',
          dataset: { focus: 'race-quit' },
          on: { click: () => controller.quit() }
        })
      ]));
      return section;
    }
    section.appendChild(screenHeading(doc, 'Race', config
      ? modeLabel(config.mode) + ' / ' + (config.mapLabel ?? config.mapId) + ' / ' + (config.carName ?? config.carSlug)
      : 'No race', 'STEP 5 / 6'));
    section.appendChild(h(doc, 'div', { class: 'gs-panel gs-race-panel' }, [
      h(doc, 'h2', { class: 'gs-panel-title', text: 'SHELL RACE SCREEN' }),
      h(doc, 'p', { text: 'The real e1-drive WebGPU canvas is not mounted in this standalone shell. This screen is where the integration hands the viewport to the engine and never reloads the page.' }),
      config ? h(doc, 'dl', { class: 'gs-config-list' }, [
        h(doc, 'dt', { text: 'MODE' }), h(doc, 'dd', { text: modeLabel(config.mode) + ' / ' + courseLabel(config.course) }),
        h(doc, 'dt', { text: 'CAR' }), h(doc, 'dd', { text: config.carName ?? config.carSlug ?? 'none' }),
        h(doc, 'dt', { text: 'MAP' }), h(doc, 'dd', { text: (config.mapLabel ?? config.mapId ?? 'none') + ' / ' + (config.mapLevel ?? '') }),
        config.mp ? h(doc, 'dt', { text: 'ROOM' }) : null,
        config.mp ? h(doc, 'dd', { text: config.mp.role + ' / ' + (config.mp.roomCode || 'code on connect') + ' / AI ' + config.mp.aiCount }) : null
      ]) : null
    ]));
    section.appendChild(h(doc, 'div', { class: 'gs-action-row' }, [
      options.demo === true ? h(doc, 'button', {
        class: 'gs-button gs-button-primary',
        type: 'button',
        text: 'SIMULATE FINISH',
        dataset: { focus: 'race-finish' },
        on: { click: () => controller.finish(demoResult(state)) }
      }) : null,
      h(doc, 'button', {
        class: 'gs-button',
        type: 'button',
        text: 'ABANDON RACE',
        dataset: { focus: 'race-quit' },
        on: { click: () => controller.quit() }
      })
    ]));
    section.appendChild(h(doc, 'p', { class: 'gs-footnote', text: 'Demo finish times are synthetic and labelled; they are not a game capture or a physics result.' }));
    return section;
  }

  function renderResults() {
    const section = h(doc, 'section', { class: 'gs-screen gs-screen-results' });
    const result = state.results;
    section.appendChild(screenHeading(doc, 'Results', result
      ? modeLabel(result.mode ?? state.mode) + ' / ' + (result.mapLabel ?? result.mapId ?? 'map') + ' / ' + courseLabel(result.course ?? '')
      : 'No result recorded', 'STEP 6 / 6'));
    appendChild(doc, section, noticeBanner(doc, state.notice, () => dispatch({ type: 'notice/clear' })));
    if (!result) {
      section.appendChild(h(doc, 'div', { class: 'gs-empty' }, [h(doc, 'p', { text: 'No result has arrived.' })]));
      return section;
    }
    if (result.synthetic) {
      section.appendChild(h(doc, 'p', { class: 'gs-demo-badge', text: 'DEMO RESULT - synthetic times, not an engine capture' }));
    }
    const showBest = result.mode === 'lap' || result.positions.some((row) => row.bestLapSeconds !== null);
    const table = h(doc, 'table', { class: 'gs-results' }, [
      h(doc, 'caption', { text: 'Race result' }),
      h(doc, 'thead', {}, [
        h(doc, 'tr', {}, [
          h(doc, 'th', { text: 'POS', attrs: { scope: 'col' } }),
          h(doc, 'th', { text: 'DRIVER', attrs: { scope: 'col' } }),
          h(doc, 'th', { text: 'CAR', attrs: { scope: 'col' } }),
          h(doc, 'th', { text: 'TIME', attrs: { scope: 'col' } }),
          showBest ? h(doc, 'th', { text: 'BEST LAP', attrs: { scope: 'col' } }) : null,
          h(doc, 'th', { text: 'LAPS', attrs: { scope: 'col' } })
        ])
      ]),
      h(doc, 'tbody', {}, result.positions.map((row) => h(doc, 'tr', {
        dataset: { position: row.position }
      }, [
        h(doc, 'td', { text: 'P' + row.position }),
        h(doc, 'td', {}, [
          h(doc, 'span', { text: row.name }),
          row.ai ? h(doc, 'span', { class: 'gs-ai-tag', text: 'AI' }) : null
        ]),
        h(doc, 'td', { text: row.car ?? '—' }),
        h(doc, 'td', { text: row.dnf ? 'DNF' : (formatSeconds(row.timeSeconds) ?? '—') }),
        showBest ? h(doc, 'td', { text: formatSeconds(row.bestLapSeconds) ?? '—' }) : null,
        h(doc, 'td', { text: row.laps ?? '—' })
      ])))
    ]);
    section.appendChild(table);
    section.appendChild(h(doc, 'div', { class: 'gs-action-row' }, [
      h(doc, 'button', {
        class: 'gs-button gs-button-primary',
        type: 'button',
        text: 'REMATCH',
        dataset: { focus: 'rematch' },
        on: { click: () => controller.rematch() }
      }),
      h(doc, 'button', {
        class: 'gs-button',
        type: 'button',
        text: 'EXIT TO MENU',
        dataset: { focus: 'exit' },
        on: { click: () => controller.exit() }
      })
    ]));
    section.appendChild(h(doc, 'p', { class: 'gs-footnote', text: 'Rematch reuses the same configuration without a page reload. In an online room it returns to the lobby so every player can ready again.' }));
    return section;
  }

  // ---------------------------------------------------------------- keyboard

  function moveGrid(element, key) {
    const grid = element.dataset?.grid;
    if (!grid || !activeScreen) return false;
    const items = [...activeScreen.querySelectorAll('[data-grid="' + grid + '"] [data-grid-index]')]
      .filter((item) => item.disabled !== true && item.hidden !== true);
    if (!items.length) return false;
    const index = Number(element.dataset.gridIndex);
    if (!Number.isInteger(index)) return false;
    const columns = Number(element.dataset.gridColumns ?? 1);
    const next = nextGridIndex(index, items.length, key, columns);
    if (next === index) return true;
    items[next]?.focus?.();
    return true;
  }

  function onKeyDown(event) {
    if (event.defaultPrevented) return;
    if (event.key === 'Escape') {
      if (state.screen === 'main-menu' || state.screen === 'boot') return;
      event.preventDefault();
      controller.back();
      return;
    }
    const active = doc.activeElement;
    if (active && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      if (moveGrid(active, event.key)) {
        event.preventDefault();
        return;
      }
    }
    if (event.key !== 'Tab') return;
    const list = focusables();
    if (!list.length) return;
    const first = list[0];
    const last = list[list.length - 1];
    if (!list.includes(active)) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  root.addEventListener('keydown', onKeyDown);
  cleanup.push(() => root.removeEventListener('keydown', onKeyDown));

  function onGamepadIntent(intent) {
    if (!intent) return;
    if (intent === 'back') {
      if (state.screen !== 'main-menu' && state.screen !== 'boot') controller.back();
      return;
    }
    if (intent === 'confirm') {
      const active = doc.activeElement;
      if (active?.click) active.click();
      return;
    }
    const key = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' }[intent];
    const active = doc.activeElement;
    if (active && moveGrid(active, key)) return;
    const list = focusables();
    if (list.length) {
      const currentIndex = list.indexOf(active);
      const delta = intent === 'up' || intent === 'left' ? -1 : 1;
      const next = currentIndex < 0 ? 0 : (currentIndex + delta + list.length) % list.length;
      list[next].focus();
    }
  }

  function enableGamepad() {
    if (gamepadFrame !== null) return () => {};
    const view = doc.defaultView ?? globalThis;
    if (typeof view.requestAnimationFrame !== 'function' || typeof view.navigator?.getGamepads !== 'function') {
      return () => {};
    }
    const loop = () => {
      if (destroyed) return;
      const pads = view.navigator.getGamepads?.() ?? [];
      const pad = [...pads].find((entry) => entry && entry.connected !== false) ?? null;
      if (pad) {
        const intent = gamepadIntent(pad.buttons, pad.axes, gamepadPrevious);
        gamepadPrevious = {
          buttons: [...pad.buttons].map((button) => button?.pressed === true),
          axes: [...pad.axes]
        };
        onGamepadIntent(intent);
      }
      gamepadFrame = view.requestAnimationFrame(loop);
    };
    gamepadFrame = view.requestAnimationFrame(loop);
    return () => {
      if (gamepadFrame !== null) view.cancelAnimationFrame?.(gamepadFrame);
      gamepadFrame = null;
    };
  }

  // ---------------------------------------------------------------- timers

  if (options.loadingTimer !== false) {
    const interval = Number.isFinite(options.loadingTickMs) ? options.loadingTickMs : 250;
    if (interval > 0 && typeof setInterval === 'function') {
      loadingTimer = setInterval(() => {
        if (!destroyed && state.screen === 'loading') dispatch({ type: 'loading/tick' });
      }, interval);
      cleanup.push(() => clearInterval(loadingTimer));
    }
  }

  // ---------------------------------------------------------------- API

  const controller = {
    on,
    root,
    getState: () => state,
    dispatch,
    selectMode: (mode) => { dispatch({ type: 'mode/select', mode }); },
    selectCar: (slug) => { dispatch({ type: 'car/select', slug }); },
    confirmCar: () => { dispatch({ type: 'car/confirm' }); },
    setCarFilter: (patch) => { dispatch({ type: 'filters/set', patch }); },
    selectMap: (mapId) => { dispatch({ type: 'map/select', mapId }); },
    openLobby: () => {
      const before = state.screen;
      dispatch({ type: 'lobby/open' });
      if (state.screen === 'lobby' && before !== 'lobby') emit('lobby', { config: buildConfig(state) });
      return state.screen === 'lobby';
    },
    start: () => {
      const gate = startRejection(state);
      if (!gate.ok) {
        dispatch({ type: 'notice', code: gate.code, message: gate.reason });
        return { ok: false, code: gate.code, reason: gate.reason };
      }
      const before = state.screen;
      dispatch({ type: 'start' });
      if (state.screen === 'loading' && before !== 'loading') {
        emit('start', state.lastConfig);
      }
      return { ok: true, config: state.lastConfig };
    },
    retryLoading: () => {
      dispatch({ type: 'loading/retry' });
      emit('retry', { config: state.lastConfig, attempt: state.loading.attempt });
    },
    raceReady: () => {
      if (state.screen !== 'loading') return false;
      dispatch({ type: 'loading/ready' });
      if (state.screen === 'race') {
        emit('race', { config: state.race.config });
        return true;
      }
      return false;
    },
    failLoading: (error) => { dispatch({ type: 'loading/fail', error }); },
    finish: (result) => {
      const before = state.screen;
      dispatch({ type: 'race/finish', result });
      if (state.screen === 'results' && before !== 'results') {
        emit('finish', state.results);
        emit('results', state.results);
        return true;
      }
      return false;
    },
    rematch: () => {
      if (state.screen !== 'results') return false;
      const config = state.lastConfig;
      dispatch({ type: 'results/rematch' });
      emit('rematch', { config, screen: state.screen });
      if (state.screen === 'loading') emit('start', state.lastConfig);
      return true;
    },
    quit: () => {
      const before = state.screen;
      dispatch({ type: 'race/quit' });
      emit('quit', { from: before, config: state.lastConfig });
    },
    exit: () => { dispatch({ type: 'results/exit' }); },
    back: () => {
      const before = state.screen;
      const config = state.lastConfig;
      dispatch({ type: 'back' });
      if (state.screen !== before) {
        emit('back', { from: before, to: state.screen, config });
        if (before === 'lobby') emit('leave-room', { roomCode: state.mp.roomCode });
        if (before === 'race' || before === 'loading') emit('quit', { from: before, config });
      }
      return state.screen;
    },
    bootReady: () => { dispatch({ type: 'boot/ready' }); },
    bootFail: (error) => { dispatch({ type: 'boot/fail', error }); },
    setData: (data = {}) => {
      dispatch({
        type: 'data/set',
        cars: data.cars,
        maps: data.maps,
        classes: data.classes,
        measurements: data.measurements
      });
    },
    setRole: (role) => { dispatch({ type: 'mp/set-role', role }); },
    setRoomCode: (code) => { dispatch({ type: 'mp/set-room-code', code }); },
    setPlayers: (players) => { dispatch({ type: 'mp/set-players', players }); },
    setReady: (ready) => { dispatch({ type: 'mp/set-ready', ready }); },
    setMpVerified: (verified) => { dispatch({ type: 'mp/set-verified', verified }); },
    setMpMap: (mapId) => { dispatch({ type: 'mp/set-map', mapId }); },
    setAi: (config = {}) => {
      dispatch({ type: 'mp/set-ai', count: config.count ?? state.mp.ai.count, cars: config.cars, profiles: config.profiles });
      if (Array.isArray(config.cars)) {
        config.cars.slice(0, state.mp.ai.count).forEach((slug, index) => {
          if (slug) dispatch({ type: 'mp/set-ai-car', index, slug });
        });
      }
      if (Array.isArray(config.profiles)) {
        config.profiles.slice(0, state.mp.ai.count).forEach((profile, index) => {
          if (profile) dispatch({ type: 'mp/set-ai-profile', index, profile });
        });
      }
    },
    setAiCar: (index, slug) => { dispatch({ type: 'mp/set-ai-car', index, slug }); },
    setAiProfile: (index, profile) => { dispatch({ type: 'mp/set-ai-profile', index, profile }); },
    setPowerups: (enabled) => { dispatch({ type: 'mp/set-powerups', enabled }); },
    setMatchMode: (matchMode) => { dispatch({ type: 'mp/set-match-mode', matchMode }); },
    setMp: (patch = {}) => {
      if (!patch || typeof patch !== 'object') return;
      if ('role' in patch) controller.setRole(patch.role);
      if ('roomCode' in patch) controller.setRoomCode(patch.roomCode);
      if ('players' in patch) controller.setPlayers(patch.players);
      if ('mapId' in patch) controller.setMpMap(patch.mapId);
      if ('ai' in patch) controller.setAi(patch.ai);
      if ('powerups' in patch) controller.setPowerups(patch.powerups);
      if ('verified' in patch) controller.setMpVerified(patch.verified);
      if ('ready' in patch) controller.setReady(patch.ready);
    },
    enableGamepad,
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      for (const fn of cleanup) fn();
      cleanup.length = 0;
      listeners.clear();
      if (gamepadFrame !== null) {
        const view = doc.defaultView ?? globalThis;
        view.cancelAnimationFrame?.(gamepadFrame);
        gamepadFrame = null;
      }
      if (root.parentNode === host) host.removeChild(root);
      else root.remove?.();
    }
  };

  if (reducedMotion) root.dataset.reducedMotion = 'true';
  render();
  return controller;
}

/** Deterministic shell-demo result. Clearly labelled synthetic by `source`. */
export function demoResult(state) {
  const config = state.lastConfig ?? buildConfig(state);
  const mapLength = activeMapForConfig(state)?.lengths?.[config.course] ?? null;
  const isFree = config.course === 'free';
  const rows = [];
  const base = isFree ? null : config.mode === 'lap' ? 86.1 : Math.max(6, (mapLength ?? 310) / 22);
  const human = state.mp.players.filter((player) => player.connected !== false && player.ai !== true);
  const names = config.mode === 'multiplayer'
    ? (human.length ? human.map((player) => player.name) : ['You'])
    : ['You'];
  if (config.mode === 'multiplayer') {
    for (let index = 0; index < state.mp.ai.count; index++) {
      names.push('AI ' + (index + 1));
    }
  }
  names.forEach((name, index) => {
    rows.push({
      position: index + 1,
      name,
      car: config.carSlug,
      timeSeconds: base === null ? null : Number((base + index * 0.217).toFixed(3)),
      bestLapSeconds: config.mode === 'lap' && base !== null ? Number((base / 3 + index * 0.07).toFixed(3)) : null,
      laps: config.mode === 'lap' ? 3 : isFree ? null : 1,
      ai: name.startsWith('AI '),
      dnf: false
    });
  });
  return {
    positions: rows,
    mode: config.mode,
    mapId: config.mapId,
    mapLabel: config.mapLabel,
    course: config.course,
    raceId: 'shell-demo-' + configSignature(config),
    synthetic: true,
    source: 'game-shell.demo'
  };
}
