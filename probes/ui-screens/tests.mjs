// ui-screens test suite — pure state machine + DOM-shim renderer.
//
// Run with the bundled Node:
//   & "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe" probes/ui-screens/tests.mjs
//
// The suite writes `_work/ui-screens/tests.json` and a log line to
// `_work/logs/ui-screens/ui-tests.log`. Repeated runs are byte-identical.

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  BINDING_ACTIONS,
  BINDING_IDS,
  ERROR_CATALOG,
  SCREEN_DEFS,
  SCREEN_IDS,
  SETTINGS_SCHEMA,
  SETTINGS_SECTIONS,
  UI_LOCAL_SETTINGS_KEY,
  UI_SCREENS_VERSION,
  activeScreen,
  bindingCodes,
  buildDiagnostic,
  canonicalJson,
  captureBinding,
  classifyBrowser,
  closeScreen,
  createUiState,
  defaultBindings,
  defaultSettings,
  diagnosticText,
  escapeIntent,
  findBindingConflict,
  fnv1a32,
  gamepadIntent,
  isOpen,
  navigateFocus,
  nextFocusIndex,
  normalizeBindings,
  openScreen,
  pausePolicy,
  reduce,
  redactDiagnostics,
  resolveError,
  sanitizeText,
  settingsFromLocalDocument,
  settingsFromProfile,
  settingsValuesToLocalDocument,
  settingsValuesToProfilePatch,
  snapshotReport,
  snapshotStates,
  trapFocusIndex,
  validateSettingValue
} from './screens.mjs';
import { mountUiScreens } from './screens.js';
import { createHost, dispatchKey, keyEvent } from './dom-shim.mjs';

// ---------------------------------------------------------------- harness

const cases = [];
const failures = [];
let assertions = 0;
let passedAssertions = 0;
let currentCase = null;

function assert(condition, message) {
  assertions += 1;
  if (condition) {
    passedAssertions += 1;
    return;
  }
  throw new Error(message || 'assertion failed');
}

function assertEqual(actual, expected, message) {
  const same = Object.is(actual, expected) ||
    (actual && expected && typeof actual === 'object' &&
      canonicalJson(actual) === canonicalJson(expected));
  assert(same, (message || 'values differ') + ' — actual=' + JSON.stringify(actual) + ' expected=' + JSON.stringify(expected));
}

function assertDeep(actual, expected, message) {
  assertEqual(canonicalJson(actual), canonicalJson(expected), message);
}

async function test(name, fn) {
  currentCase = name;
  try {
    await fn();
    cases.push({ name, ok: true });
  } catch (error) {
    cases.push({ name, ok: false, error: String(error.message ?? error) });
    failures.push({ name, error: String(error.message ?? error) });
  }
}

function findButton(root, focus) {
  return root.querySelector('[data-focus="' + focus + '"]');
}

function withUi(options, fn) {
  const { document, host } = createHost();
  const ui = mountUiScreens(host, { ...options, document });
  try {
    return fn(ui, document, host);
  } finally {
    ui.destroy();
  }
}

function effectsOf(state, type) {
  return (state.effects || []).filter((effect) => effect.type === type);
}

// ---------------------------------------------------------------- constants

await test('screen ids and defs are complete and honest', () => {
  assertEqual(SCREEN_IDS.length, 9);
  for (const id of ['pause', 'settings', 'controls', 'loading', 'connection-lost', 'version-mismatch', 'unsupported-browser', 'confirm-quit', 'error-details']) {
    assert(SCREEN_IDS.includes(id), 'missing screen ' + id);
    assert(Boolean(SCREEN_DEFS[id]), 'missing def ' + id);
    assertEqual(SCREEN_DEFS[id].retailDerived, false, 'screen ' + id + ' must not claim retail derivation');
    assert(SCREEN_DEFS[id].title.length > 0, 'screen ' + id + ' needs a title');
    assert(SCREEN_DEFS[id].description.length > 0, 'screen ' + id + ' needs a description');
  }
  assertEqual(UI_SCREENS_VERSION, 1);
  assertEqual(UI_LOCAL_SETTINGS_KEY, 'blur.ui.local.v1');
});

await test('settings schema counts and scopes are exact', () => {
  const profile = SETTINGS_SCHEMA.filter((entry) => entry.scope === 'profile');
  const local = SETTINGS_SCHEMA.filter((entry) => entry.scope === 'local');
  assertEqual(profile.length, 12, 'profile settings count');
  assertEqual(local.length, 3, 'local settings count');
  assertEqual(SETTINGS_SCHEMA.length, 15);
  assertEqual(SETTINGS_SECTIONS.length, 5);
  assertEqual(local.map((entry) => entry.path).sort().join(','), 'display.resolutionScale,display.vsync,language');
  assert(profile.every((entry) => entry.retailDerived === true), 'profile fields are retail-schema derived');
  assert(local.every((entry) => entry.retailDerived === false), 'local fields are project extensions');
});

await test('INPUT1 action list is consumed for bindings', () => {
  assertEqual(BINDING_ACTIONS.length, 31, '29 INPUT1 actions + 2 steer axes');
  assertEqual(BINDING_IDS.length, 31);
  for (const id of ['throttle', 'brake', 'handbrake', 'changeView', 'resetVehicle', 'usePickup', 'useShield', 'rearView']) {
    assert(BINDING_IDS.includes(id), 'missing INPUT1 action ' + id);
  }
  assert(BINDING_IDS.includes('steerLeft'));
  assert(BINDING_IDS.includes('steerRight'));
});

await test('error catalog entries are typed and complete', () => {
  const codes = Object.keys(ERROR_CATALOG);
  assert(codes.length >= 20, 'catalog size');
  for (const code of codes) {
    const entry = ERROR_CATALOG[code];
    assertEqual(entry.code, code, 'code key matches');
    assert(entry.title.length > 3, code + ' title');
    assert(entry.explanation.length > 10, code + ' explanation');
    assert(['error', 'warning', 'info'].includes(entry.severity), code + ' severity');
    assert(entry.action.length > 0, code + ' action');
    assert(entry.source.length > 0, code + ' source');
  }
  assert(ERROR_CATALOG.PROFILE_QUOTA_EXCEEDED.profileCode === 'quota-exceeded');
  assert(ERROR_CATALOG.PROFILE_READ_ONLY.profileCode === 'read-only');
});

// ------------------------------------------------------------- state machine

await test('fresh state and defaults', () => {
  const state = createUiState({});
  assertEqual(state.context, 'menu');
  assertEqual(state.mode, 'solo');
  assertEqual(state.stack.length, 0);
  assert(!isOpen(state));
  assertEqual(activeScreen(state), null);
  assertEqual(state.revision, 0);
  assertEqual(state.paused, false);
  assertDeep(state.settings.values, defaultSettings());
  assertEqual(state.settings.dirty, false);
  assertEqual(state.settings.profileReadOnly, false);
  assertEqual(Object.keys(state.bindings.keyboard.actions).length, 29);
});

await test('open pause and close', () => {
  let state = createUiState({ context: 'race', mode: 'solo' });
  state = openScreen(state, 'pause');
  assert(isOpen(state));
  assertEqual(activeScreen(state).id, 'pause');
  assertEqual(state.paused, true);
  assert(effectsOf(state, 'pause').length === 1, 'pause effect');
  assert(effectsOf(state, 'open').length === 1, 'open effect');
  assert(state.revision > 0);
  state = closeScreen(state);
  assert(!isOpen(state));
  assertEqual(state.paused, false);
  assert(effectsOf(state, 'resume').length === 1, 'resume effect');
});

await test('nested pause -> settings -> controls -> back', () => {
  let state = createUiState({ context: 'race', mode: 'solo' });
  state = openScreen(state, 'pause');
  state = openScreen(state, 'settings');
  assertEqual(activeScreen(state).id, 'settings');
  state = openScreen(state, 'controls');
  assertEqual(activeScreen(state).id, 'controls');
  state = reduce(state, { type: 'ui/back' });
  assertEqual(activeScreen(state).id, 'settings');
  state = reduce(state, { type: 'ui/back' });
  assertEqual(activeScreen(state).id, 'pause');
  state = reduce(state, { type: 'ui/back' });
  assert(!isOpen(state));
});

await test('invalid transitions are rejected with a typed reason', () => {
  let state = createUiState({ context: 'race' });
  state = openScreen(state, 'pause');
  const rejected = openScreen(state, 'loading');
  assertEqual(rejected.stack.length, 1);
  assertEqual(effectsOf(rejected, 'ui/rejected')[0].reason, 'invalid-transition');
  const same = openScreen(state, 'pause');
  assertEqual(effectsOf(same, 'ui/rejected')[0].reason, 'already-open');
  const unknown = openScreen(state, 'nope');
  assertEqual(effectsOf(unknown, 'ui/rejected')[0].reason, 'unknown-screen');
  state = openScreen(state, 'settings');
  const noPause = openScreen(state, 'pause');
  assertEqual(effectsOf(noPause, 'ui/rejected')[0].reason, 'invalid-transition');
});

await test('error details needs a code or an existing error', () => {
  const state = createUiState({});
  const rejected = openScreen(state, 'error-details');
  assertEqual(effectsOf(rejected, 'ui/rejected')[0].reason, 'missing-error-code');
  const opened = openScreen(state, 'error-details', { code: 'ASSET_LOAD_FAILED' });
  assertEqual(activeScreen(opened).id, 'error-details');
  assertEqual(opened.error.code, 'ASSET_LOAD_FAILED');
  assert(opened.error.diagnostic);
});

await test('error details can overlay any screen', () => {
  let state = createUiState({ context: 'race' });
  state = openScreen(state, 'pause');
  state = openScreen(state, 'settings');
  state = openScreen(state, 'controls');
  state = openScreen(state, 'error-details', { code: 'NETWORK_LOST' });
  assertEqual(activeScreen(state).id, 'error-details');
  assertEqual(state.stack.length, 4);
});

await test('escape is owned while open and unhandled while closed', () => {
  const closed = createUiState({});
  assertEqual(escapeIntent(closed).owned, false);
  const closedResult = reduce(closed, { type: 'ui/escape' });
  assertEqual(effectsOf(closedResult, 'escape-unhandled').length, 1);
  let state = createUiState({ context: 'race' });
  state = openScreen(state, 'pause');
  assertEqual(escapeIntent(state).owned, true);
  state = reduce(state, { type: 'ui/escape' });
  assert(!isOpen(state));
});

await test('close-all clears the stack and resumes solo play', () => {
  let state = createUiState({ context: 'race', mode: 'solo' });
  state = openScreen(state, 'pause');
  state = openScreen(state, 'settings');
  state = reduce(state, { type: 'ui/close-all' });
  assert(!isOpen(state));
  assertEqual(state.paused, false);
  assertEqual(effectsOf(state, 'close-all')[0].screens.length, 2);
  assert(effectsOf(state, 'resume').length === 1);
});

await test('solo pause policy pauses the simulation', () => {
  let state = createUiState({ context: 'race', mode: 'solo' });
  const policy = pausePolicy(state);
  assertEqual(policy.canPause, true);
  assertEqual(policy.pausesSimulation, true);
  assertEqual(policy.authority, 'local');
  state = openScreen(state, 'settings');
  assertEqual(state.paused, true);
});

await test('multiplayer host and guest never pause the room', () => {
  for (const mode of ['host', 'guest']) {
    let state = createUiState({ context: 'race', mode });
    const policy = pausePolicy(state);
    assertEqual(policy.canPause, false, mode + ' canPause');
    assertEqual(policy.pausesSimulation, false, mode + ' pausesSimulation');
    assertEqual(policy.authority, 'host');
    assertEqual(policy.roomContinues, true);
    state = openScreen(state, 'pause');
    assertEqual(state.paused, false, mode + ' state.paused');
    assert(effectsOf(state, 'session-menu').length === 1, mode + ' session-menu effect');
    assertEqual(effectsOf(state, 'session-menu')[0].roomContinues, true);
    assert(effectsOf(state, 'pause').length === 0, mode + ' must not emit pause');
  }
});

await test('pause policy outside a race', () => {
  const policy = pausePolicy(createUiState({ context: 'menu' }));
  assertEqual(policy.canPause, false);
  assertEqual(policy.pausesSimulation, false);
  assertEqual(policy.authority, 'none');
});

await test('context change recomputes pause and validates input', () => {
  let state = createUiState({ context: 'menu', mode: 'solo' });
  state = openScreen(state, 'pause');
  assertEqual(state.paused, false);
  state = reduce(state, { type: 'ui/set-context', context: 'race', mode: 'solo' });
  assertEqual(state.paused, true);
  const bad = reduce(state, { type: 'ui/set-context', context: 'galaxy' });
  assertEqual(effectsOf(bad, 'ui/rejected')[0].reason, 'unknown-context');
  const badMode = reduce(state, { type: 'ui/set-context', context: 'race', mode: 'nope' });
  assertEqual(effectsOf(badMode, 'ui/rejected')[0].reason, 'unknown-mode');
});

await test('confirm quit flow', () => {
  let state = createUiState({ context: 'race', mode: 'solo' });
  state = openScreen(state, 'pause');
  state = reduce(state, { type: 'quit/request', target: 'menu' });
  assertEqual(activeScreen(state).id, 'confirm-quit');
  assertEqual(state.confirmQuit.target, 'menu');
  state = reduce(state, { type: 'quit/cancel' });
  assertEqual(activeScreen(state).id, 'pause');
  state = reduce(state, { type: 'quit/request', target: 'menu' });
  const quit = reduce(state, { type: 'quit/confirm' });
  assert(!isOpen(quit));
  assertEqual(quit.paused, false);
  assertEqual(effectsOf(quit, 'quit')[0].target, 'menu');
  assert(effectsOf(quit, 'resume').length === 1);
});

await test('confirm quit in multiplayer never emits resume', () => {
  let state = createUiState({ context: 'race', mode: 'guest' });
  state = reduce(state, { type: 'quit/request', target: 'room', roomCode: 'K7M2Q' });
  assertEqual(state.confirmQuit.roomCode, 'K7M2Q');
  const quit = reduce(state, { type: 'quit/confirm' });
  assertEqual(effectsOf(quit, 'quit')[0].roomContinues, true);
  assertEqual(effectsOf(quit, 'resume').length, 0);
});

await test('connection lost, retry, cancel', () => {
  let state = createUiState({ context: 'race', mode: 'host' });
  state = reduce(state, { type: 'connection/lost', code: 'NETWORK_LOST', attempt: 0, roomCode: 'K7M2Q', latencyMs: 91 });
  assertEqual(activeScreen(state).id, 'connection-lost');
  assertEqual(state.connection.attempt, 0);
  state = reduce(state, { type: 'connection/retry' });
  assertEqual(state.connection.attempt, 1);
  assertEqual(state.connection.status, 'reconnecting');
  assertEqual(effectsOf(state, 'connection-retry')[0].attempt, 1);
  state = reduce(state, { type: 'connection/retry' });
  state = reduce(state, { type: 'connection/retry' });
  assertEqual(state.connection.attempt, 3);
  const cancelled = reduce(state, { type: 'connection/cancel' });
  assert(!isOpen(cancelled));
  assertEqual(cancelled.connection, null);
  assertEqual(effectsOf(cancelled, 'connection-cancel')[0].code, 'NETWORK_LOST');
});

await test('version mismatch carries expected and actual', () => {
  let state = createUiState({ context: 'menu' });
  state = reduce(state, { type: 'version/show', expected: '2', actual: '1', kind: 'profile' });
  assertEqual(activeScreen(state).id, 'version-mismatch');
  assertEqual(state.versionInfo.expected, '2');
  assertEqual(state.versionInfo.actual, '1');
  assertEqual(state.versionInfo.kind, 'profile');
  assertEqual(effectsOf(state, 'version-mismatch')[0].expected, '2');
});

await test('unsupported browser state and details', () => {
  let state = createUiState({ context: 'boot' });
  state = reduce(state, { type: 'browser/show', missing: ['BROWSER_NO_WEBGPU', 'BROWSER_NO_CRYPTO_SUBTLE'] });
  assertEqual(activeScreen(state).id, 'unsupported-browser');
  assertEqual(state.browser.missing.length, 2);
  assertEqual(state.browser.code, 'BROWSER_UNSUPPORTED');
  const details = reduce(state, { type: 'browser/details' });
  assertEqual(activeScreen(details).id, 'error-details');
  assertEqual(details.error.code, 'BROWSER_UNSUPPORTED');
  assertEqual(details.error.diagnostic.missing.length, 2);
});

await test('loading state update and cancel', () => {
  let state = createUiState({ context: 'menu' });
  state = openScreen(state, 'loading', { label: 'Map pins', progress: 0.2, attempt: 1 });
  assertEqual(state.loading.progress, 0.2);
  state = reduce(state, { type: 'loading/update', progress: 0.8, label: 'Car chunk' });
  assertEqual(state.loading.progress, 0.8);
  assertEqual(state.loading.label, 'Car chunk');
  state = reduce(state, { type: 'loading/update', progress: 4 });
  assertEqual(state.loading.progress, 1, 'progress clamps to 1');
  state = reduce(state, { type: 'loading/update', progress: -2 });
  assertEqual(state.loading.progress, 0, 'progress clamps to 0');
  const cancelled = reduce(state, { type: 'loading/cancel' });
  assert(!isOpen(cancelled));
  assertEqual(effectsOf(cancelled, 'loading-cancel').length, 1);
});

await test('unknown actions and invalid focus are rejected', () => {
  const state = createUiState({});
  const bad = reduce(state, { type: 'nope/nope' });
  assertEqual(effectsOf(bad, 'ui/rejected')[0].reason, 'unknown-action');
  const focus = reduce(state, { type: 'ui/focus', index: -1 });
  assertEqual(effectsOf(focus, 'ui/rejected')[0].reason, 'invalid-focus-index');
  const good = reduce(state, { type: 'ui/focus', index: 3 });
  assertEqual(good.focus.index, 3);
});

// ---------------------------------------------------------------- focus trap

await test('mount renders a labelled dialog and focuses the autofocus action', () => {
  await withUi({ context: 'race', mode: 'solo' }, (ui, document) => {
    assert(ui.element.hidden === true, 'closed overlay is hidden');
    ui.open('pause');
    const panel = ui.element.querySelector('.uis-panel');
    assertEqual(panel.getAttribute('role'), 'dialog');
    assertEqual(panel.getAttribute('aria-modal'), 'true');
    assertEqual(panel.getAttribute('aria-labelledby'), 'uis-title');
    assertEqual(panel.getAttribute('aria-describedby'), 'uis-desc');
    assert(ui.element.querySelector('#uis-title'), 'title exists');
    assert(document.activeElement.dataset.focus === 'resume', 'resume is focused');
    assert(ui.element.hidden === false, 'open overlay is visible');
    assertEqual(ui.element.dataset.paused, 'true');
  });
});

await test('focusables stay inside the panel', () => {
  await withUi({ context: 'race' }, (ui) => {
    ui.open('pause');
    const list = ui.focusables();
    assert(list.length >= 4, 'pause has at least four actions');
    const panel = ui.element.querySelector('.uis-panel');
    assert(list.every((element) => {
      let cursor = element;
      while (cursor) {
        if (cursor === panel) return true;
        cursor = cursor.parentNode;
      }
      return false;
    }), 'every focusable is a panel descendant');
  });
});

await test('Tab wraps from the last item to the first', () => {
  await withUi({ context: 'race' }, (ui, document) => {
    ui.open('pause');
    const list = ui.focusables();
    list[list.length - 1].focus();
    const event = keyEvent('Tab');
    assertEqual(ui.handleKey(event), true);
    assert(event.defaultPrevented);
    assert(document.activeElement === list[0], 'wrapped to first');
  });
});

await test('Shift+Tab wraps from the first item to the last', () => {
  await withUi({ context: 'race' }, (ui, document) => {
    ui.open('pause');
    const list = ui.focusables();
    list[0].focus();
    ui.handleKey(keyEvent('Tab', { shiftKey: true }));
    assert(document.activeElement === list[list.length - 1], 'wrapped to last');
  });
});

await test('Tab with no active element focuses the first item', () => {
  await withUi({ context: 'race' }, (ui, document) => {
    ui.open('pause');
    document.activeElement = null;
    const list = ui.focusables();
    ui.handleKey(keyEvent('Tab'));
    assert(document.activeElement === list[0]);
  });
});

await test('Escape closes the top screen and is consumed', () => {
  await withUi({ context: 'race' }, (ui, document) => {
    ui.open('pause');
    ui.open('settings');
    const event = keyEvent('Escape');
    assertEqual(ui.handleKey(event), true);
    assert(event.defaultPrevented);
    assertEqual(ui.state().stack.length, 1);
    assertEqual(ui.state().stack[0].id, 'pause');
    assert(document.activeElement.dataset.focus === 'pause-settings' || document.activeElement.dataset.focus === 'resume');
  });
});

await test('Escape while closed is not owned', () => {
  await withUi({ context: 'race' }, (ui) => {
    const event = keyEvent('Escape');
    assertEqual(ui.handleKey(event), false);
    assert(!event.defaultPrevented);
  });
});

await test('document keydown listener closes an open screen', () => {
  await withUi({ context: 'race' }, (ui, document) => {
    ui.open('pause');
    const event = dispatchKey(document, 'Escape');
    assert(event.defaultPrevented);
    assert(!isOpen(ui.state()));
  });
});

await test('focus is restored to the previous element on close', () => {
  const { document, host } = createHost();
  const outside = document.createElement('button');
  outside.textContent = 'outside';
  document.body.appendChild(outside);
  outside.focus();
  const ui = mountUiScreens(host, { context: 'race', document });
  ui.open('pause');
  assert(document.activeElement !== outside, 'focus moved into the dialog');
  ui.close();
  assert(document.activeElement === outside, 'focus restored');
  ui.destroy();
});

await test('focus survives a settings re-render', () => {
  await withUi({ context: 'race' }, (ui, document) => {
    ui.open('pause');
    ui.open('settings');
    const checkbox = ui.element.querySelector('[data-focus="setting-muted"]');
    checkbox.focus();
    ui.dispatch({ type: 'settings/set', path: 'muted', value: true });
    assert(document.activeElement.dataset.focus === 'setting-muted', 'focus key restored');
    assertEqual(ui.state().settings.values.muted, true);
  });
});

await test('hidden and disabled elements are excluded from the trap', () => {
  await withUi({ context: 'race' }, (ui) => {
    ui.open('settings');
    const list = ui.focusables();
    assert(list.every((element) => element.hidden !== true), 'no hidden');
    assert(list.every((element) => element.disabled !== true), 'no disabled');
    assert(list.length > 10, 'settings has many controls');
  });
});

await test('settings autofocuses the heading, not a random control', () => {
  await withUi({ context: 'race' }, (ui, document) => {
    ui.open('settings');
    assertEqual(document.activeElement.id, 'uis-title');
    assertEqual(document.activeElement.textContent, 'Settings');
  });
});

// ------------------------------------------------------------------ settings

await test('defaults match the schema', () => {
  const values = defaultSettings();
  for (const entry of SETTINGS_SCHEMA) {
    assertEqual(values[entry.path], entry.default, entry.path + ' default');
  }
  assertEqual(values.quality, 'high');
  assertEqual(values['volumes.master'], 0.8);
  assertEqual(values['display.vsync'], true);
  assertEqual(values.language, 'en');
});

await test('profile settings are consumed read-only and mapped', () => {
  const loaded = settingsFromProfile({
    quality: 'ultra',
    volumes: { master: 0.25, music: 0.5, sfx: 1 },
    muted: true,
    cameraMode: 'orbit',
    steer: 'inverted',
    inputBindingsRef: 'custom-table',
    hud: { showSpeed: false, showGhostDelta: true, showMinimap: true, units: 'imperial' }
  });
  assertEqual(loaded.values.quality, 'ultra');
  assertEqual(loaded.values['volumes.master'], 0.25);
  assertEqual(loaded.values.muted, true);
  assertEqual(loaded.values.cameraMode, 'orbit');
  assertEqual(loaded.values.steer, 'inverted');
  assertEqual(loaded.values.inputBindingsRef, 'custom-table');
  assertEqual(loaded.values['hud.showSpeed'], false);
  assertEqual(loaded.values['hud.showMinimap'], true);
  assertEqual(loaded.values['hud.units'], 'imperial');
  assertEqual(loaded.issues.length, 0);
  assertEqual(loaded.readOnly, false);
});

await test('invalid profile values fall back with typed issues', () => {
  const loaded = settingsFromProfile({
    quality: 'insane',
    volumes: { master: 4 },
    cameraMode: 'nose',
    hud: { units: 'parsec' }
  });
  assertEqual(loaded.values.quality, 'high');
  assertEqual(loaded.values['volumes.master'], 0.8);
  assertEqual(loaded.values.cameraMode, 'chase');
  assertEqual(loaded.values['hud.units'], 'metric');
  assert(loaded.issues.length >= 4, 'four issues');
  assert(loaded.issues.every((issue) => issue.path && issue.reason));
});

await test('a newer profile is read-only', () => {
  const loaded = settingsFromProfile({ quality: 'low' }, { schemaVersion: 2 });
  assertEqual(loaded.readOnly, true);
  assertEqual(loaded.values.quality, 'low', 'still readable');
});

await test('local settings document round-trips', () => {
  const values = defaultSettings();
  values['display.resolutionScale'] = '1.5';
  values['display.vsync'] = false;
  values.language = 'de';
  const document = settingsValuesToLocalDocument(values);
  assertEqual(document.kind, 'blur.ui.local');
  assertEqual(document.schemaVersion, 1);
  assertEqual(document.settings.display.resolutionScale, '1.5');
  assertEqual(document.settings.display.vsync, false);
  assertEqual(document.settings.language, 'de');
  assertEqual(document.retailDerived, false);
  const back = settingsFromLocalDocument(document);
  assertEqual(back['display.resolutionScale'], '1.5');
  assertEqual(back['display.vsync'], false);
  assertEqual(back.language, 'de');
});

await test('setting validation covers enums, numbers and booleans', () => {
  const quality = SETTINGS_SCHEMA.find((entry) => entry.path === 'quality');
  assertEqual(validateSettingValue(quality, 'ultra').ok, true);
  assertEqual(validateSettingValue(quality, 'insane').ok, false);
  const volume = SETTINGS_SCHEMA.find((entry) => entry.path === 'volumes.master');
  assertEqual(validateSettingValue(volume, '0.5').value, 0.5);
  assertEqual(validateSettingValue(volume, 1.5).ok, false);
  assertEqual(validateSettingValue(volume, -0.1).ok, false);
  assertEqual(validateSettingValue(volume, 0.123456).value, 0.123);
  assertEqual(validateSettingValue(volume, 'nope').ok, false);
  const muted = SETTINGS_SCHEMA.find((entry) => entry.path === 'muted');
  assertEqual(validateSettingValue(muted, true).ok, true);
  assertEqual(validateSettingValue(muted, 'true').ok, false);
  const bindings = SETTINGS_SCHEMA.find((entry) => entry.path === 'inputBindingsRef');
  assertEqual(validateSettingValue(bindings, 'x').reason, 'read-only');
});

await test('every valid enum value is accepted', () => {
  for (const entry of SETTINGS_SCHEMA.filter((field) => field.type === 'enum')) {
    for (const value of entry.values) {
      assertEqual(validateSettingValue(entry, value).ok, true, entry.path + '=' + value);
    }
  }
});

await test('set, dirty, apply effect and commit patch', () => {
  let state = createUiState({ context: 'menu' });
  state = openScreen(state, 'settings');
  state = reduce(state, { type: 'settings/set', path: 'quality', value: 'ultra' });
  assertEqual(state.settings.values.quality, 'ultra');
  assertEqual(state.settings.dirty, true);
  const apply = effectsOf(state, 'apply-setting');
  assertEqual(apply.length, 1);
  assertEqual(apply[0].scope, 'profile');
  assertEqual(apply[0].retailDerived, true);
  assertEqual(apply[0].apply, 'quality-preset');
  state = reduce(state, { type: 'settings/commit' });
  const commit = effectsOf(state, 'settings-commit')[0];
  assertEqual(commit.changed.join(','), 'quality');
  assertDeep(commit.profilePatch, { quality: 'ultra' });
  assertEqual(commit.localKey, UI_LOCAL_SETTINGS_KEY);
  assertEqual(commit.readOnly, false);
});

await test('setting the same value returns the same state', () => {
  const state = createUiState({});
  const next = reduce(state, { type: 'settings/set', path: 'quality', value: 'high' });
  assert(next === state, 'identity for a no-op');
});

await test('invalid, unknown and read-only settings are rejected', () => {
  const state = createUiState({});
  const badEnum = reduce(state, { type: 'settings/set', path: 'quality', value: 'insane' });
  assertEqual(effectsOf(badEnum, 'settings-rejected')[0].reason, 'not-in-enum');
  const badRange = reduce(state, { type: 'settings/set', path: 'volumes.sfx', value: 9 });
  assertEqual(effectsOf(badRange, 'settings-rejected')[0].reason, 'above-maximum');
  const unknown = reduce(state, { type: 'settings/set', path: 'nope', value: 1 });
  assertEqual(effectsOf(unknown, 'settings-rejected')[0].reason, 'unknown-field');
  const readOnly = reduce(state, { type: 'settings/set', path: 'inputBindingsRef', value: 'x' });
  assertEqual(effectsOf(readOnly, 'settings-rejected')[0].reason, 'read-only');
});

await test('nested HUD patch shape is exact', () => {
  let state = createUiState({});
  state = reduce(state, { type: 'settings/set', path: 'hud.showMinimap', value: true });
  state = reduce(state, { type: 'settings/set', path: 'hud.units', value: 'imperial' });
  const commit = effectsOf(reduce(state, { type: 'settings/commit' }), 'settings-commit')[0];
  assertDeep(commit.profilePatch, { hud: { showMinimap: true, units: 'imperial' } });
  assertEqual(commit.changed.sort().join(','), 'hud.showMinimap,hud.units');
});

await test('local settings are split out of the profile patch', () => {
  let state = createUiState({});
  state = reduce(state, { type: 'settings/set', path: 'display.resolutionScale', value: '1.25' });
  state = reduce(state, { type: 'settings/set', path: 'language', value: 'fr' });
  const commit = effectsOf(reduce(state, { type: 'settings/commit' }), 'settings-commit')[0];
  assertDeep(commit.profilePatch, {}, 'no profile patch for local fields');
  assertEqual(commit.local.settings.display.resolutionScale, '1.25');
  assertEqual(commit.local.settings.language, 'fr');
});

await test('saved resets dirty and the baseline', () => {
  let state = createUiState({});
  state = reduce(state, { type: 'settings/set', path: 'quality', value: 'low' });
  assertEqual(state.settings.dirty, true);
  state = reduce(state, { type: 'settings/saved', revision: 9 });
  assertEqual(state.settings.dirty, false);
  assertEqual(state.settings.values.quality, 'low');
  assertEqual(state.settings.baseline.quality, 'low');
  assertEqual(state.settings.revision, 9);
});

await test('revert restores the baseline and live-applies each change', () => {
  let state = createUiState({});
  state = reduce(state, { type: 'settings/set', path: 'quality', value: 'low' });
  state = reduce(state, { type: 'settings/set', path: 'muted', value: true });
  const reverted = reduce(state, { type: 'settings/revert' });
  assertEqual(reverted.settings.values.quality, 'high');
  assertEqual(reverted.settings.values.muted, false);
  assertEqual(reverted.settings.dirty, false);
  const applied = effectsOf(reverted, 'apply-setting');
  assertEqual(applied.length, 2);
  assert(applied.every((effect) => effect.revert === true));
});

await test('reset to defaults is a two-step path', () => {
  let state = createUiState({});
  state = reduce(state, { type: 'settings/set', path: 'quality', value: 'low' });
  state = reduce(state, { type: 'settings/reset-request' });
  assertEqual(state.settings.resetPending, true);
  const pendingValues = state.settings.values.quality;
  const cancelled = reduce(state, { type: 'settings/reset-cancel' });
  assertEqual(cancelled.settings.resetPending, false);
  assertEqual(cancelled.settings.values.quality, pendingValues, 'cancel keeps values');
  state = reduce(state, { type: 'settings/reset-request' });
  const confirmed = reduce(state, { type: 'settings/reset-confirm' });
  assertEqual(confirmed.settings.values.quality, 'high');
  assertEqual(confirmed.settings.resetPending, false);
  assertEqual(confirmed.settings.dirty, true);
  assertEqual(effectsOf(confirmed, 'settings-reset').length, 1);
  assertEqual(effectsOf(confirmed, 'apply-setting').length, SETTINGS_SCHEMA.length);
});

await test('reset confirm on pristine defaults is not dirty', () => {
  const state = createUiState({});
  const reset = reduce(state, { type: 'settings/reset-confirm' });
  assertEqual(reset.settings.dirty, false);
});

await test('settings commit is blocked on a read-only profile', () => {
  let state = createUiState({ profile: { schemaVersion: 2 } });
  assertEqual(state.settings.profileReadOnly, true);
  state = reduce(state, { type: 'settings/set', path: 'quality', value: 'ultra' });
  const committed = reduce(state, { type: 'settings/commit' });
  assertEqual(effectsOf(committed, 'settings-commit-blocked')[0].reason, 'profile-read-only');
  assertEqual(effectsOf(committed, 'settings-commit').length, 0);
});

await test('settings/load replaces values and read-only state', () => {
  let state = createUiState({});
  state = reduce(state, {
    type: 'settings/load',
    profileSettings: { quality: 'medium', volumes: { master: 0.1 } },
    revision: 12
  });
  assertEqual(state.settings.values.quality, 'medium');
  assertEqual(state.settings.values['volumes.master'], 0.1);
  assertEqual(state.settings.revision, 12);
  const future = reduce(state, { type: 'settings/load', profileSettings: { quality: 'ultra' }, schemaVersion: 2 });
  assertEqual(future.settings.profileReadOnly, true);
  assertEqual(effectsOf(future, 'settings-read-only').length, 1);
});

// ------------------------------------------------------------------ bindings

await test('default bindings derive from INPUT1 retail layout 1', () => {
  const bindings = defaultBindings({ keyboardLayout: 1 });
  assertEqual(bindings.schema, 'blur.input-bindings');
  assertEqual(bindings.keyboardLayout, 1);
  assert(bindingCodes(bindings, 'throttle', 'keyboard').includes('KeyW'));
  assert(bindingCodes(bindings, 'brake', 'keyboard').includes('KeyS'));
  assert(bindingCodes(bindings, 'steerLeft', 'keyboard').includes('KeyA'));
  assert(bindingCodes(bindings, 'steerRight', 'keyboard').includes('KeyD'));
  assert(bindingCodes(bindings, 'throttle', 'pad').includes('RightTrigger'));
});

await test('capture replaces a binding and reports it', () => {
  let state = createUiState({});
  state = openScreen(state, 'controls');
  state = reduce(state, { type: 'binding/capture-start', action: 'throttle', device: 'keyboard' });
  assertEqual(state.capture.action, 'throttle');
  assertEqual(state.capture.waiting, true);
  state = reduce(state, { type: 'binding/capture-key', code: 'KeyT' });
  assertEqual(state.capture, null);
  assert(bindingCodes(state.bindings, 'throttle', 'keyboard').includes('KeyT'));
  const effect = effectsOf(state, 'binding-captured')[0];
  assertEqual(effect.code, 'KeyT');
  assertEqual(effect.device, 'keyboard');
});

await test('capture rejects a conflict in the same context', () => {
  let state = createUiState({});
  state = reduce(state, { type: 'binding/capture-start', action: 'brake', device: 'keyboard' });
  state = reduce(state, { type: 'binding/capture-key', code: 'KeyW' });
  const rejected = effectsOf(state, 'binding-rejected')[0];
  assertEqual(rejected.reason, 'conflict');
  assertEqual(rejected.conflict.action, 'throttle');
  assert(state.capture !== null, 'capture stays open');
  assert(!bindingCodes(state.bindings, 'brake', 'keyboard').includes('KeyW'));
});

await test('conflicts are scoped to the action context', () => {
  const bindings = defaultBindings({ keyboardLayout: 1 });
  const capture = captureBinding(bindings, 'autoShufflePerks', 'keyboard', 'KeyW');
  assertEqual(capture.ok, true, 'perk context may reuse a driving key');
  const conflict = findBindingConflict(bindings, 'brake', 'keyboard', 'KeyW');
  assertEqual(conflict.action, 'throttle');
});

await test('capture validates device, code and action', () => {
  const bindings = defaultBindings({ keyboardLayout: 1 });
  assertEqual(captureBinding(bindings, 'nope', 'keyboard', 'KeyQ').reason, 'unknown-action');
  assertEqual(captureBinding(bindings, 'throttle', 'mouse', 'KeyQ').reason, 'unknown-device');
  assertEqual(captureBinding(bindings, 'throttle', 'keyboard', 'Shift+W').reason, 'invalid-keyboard-code');
  assertEqual(captureBinding(bindings, 'throttle', 'pad', 'Bench').reason, 'unknown-pad-button');
  assertEqual(captureBinding(bindings, 'steerLeft', 'pad', 'A').reason, 'axis-is-keyboard-only');
});

await test('capture-start rejects an axis on pad and unknown actions', () => {
  const state = createUiState({});
  const badAxis = reduce(state, { type: 'binding/capture-start', action: 'steerLeft', device: 'pad' });
  assertEqual(effectsOf(badAxis, 'binding-rejected')[0].reason, 'axis-is-keyboard-only');
  const badAction = reduce(state, { type: 'binding/capture-start', action: 'nope', device: 'keyboard' });
  assertEqual(effectsOf(badAction, 'binding-rejected')[0].reason, 'unknown-action');
});

await test('capture-key without a capture is rejected', () => {
  const state = createUiState({});
  const result = reduce(state, { type: 'binding/capture-key', code: 'KeyQ' });
  assertEqual(effectsOf(result, 'binding-rejected')[0].reason, 'no-keyboard-capture');
});

await test('Escape cancels keyboard capture without rebinding', () => {
  let state = createUiState({});
  state = reduce(state, { type: 'binding/capture-start', action: 'throttle', device: 'keyboard' });
  const before = bindingCodes(state.bindings, 'throttle', 'keyboard').join(',');
  state = reduce(state, { type: 'binding/capture-key', code: 'Escape' });
  assertEqual(state.capture, null);
  assertEqual(bindingCodes(state.bindings, 'throttle', 'keyboard').join(','), before);
  assertEqual(effectsOf(state, 'binding-capture-cancel')[0].action, 'throttle');
});

await test('pad capture works and rejects pad conflicts', () => {
  let state = createUiState({});
  state = reduce(state, { type: 'binding/capture-start', action: 'throttle', device: 'pad' });
  state = reduce(state, { type: 'binding/capture-pad', button: 'Y' });
  assert(bindingCodes(state.bindings, 'throttle', 'pad').includes('Y'));
  state = reduce(state, { type: 'binding/capture-start', action: 'brake', device: 'pad' });
  state = reduce(state, { type: 'binding/capture-pad', button: 'Y' });
  assertEqual(effectsOf(state, 'binding-rejected')[0].reason, 'conflict');
});

await test('steering axis captures on the keyboard only', () => {
  let state = createUiState({});
  state = reduce(state, { type: 'binding/capture-start', action: 'steerLeft', device: 'keyboard' });
  state = reduce(state, { type: 'binding/capture-key', code: 'KeyJ' });
  assertEqual(state.bindings.keyboard.steer.negative.join(','), 'KeyJ');
  assertEqual(bindingCodes(state.bindings, 'steerLeft', 'keyboard').join(','), 'KeyJ');
  assertEqual(bindingCodes(state.bindings, 'steerLeft', 'pad'), null);
});

await test('binding reset restores defaults and normalize keeps input', () => {
  let state = createUiState({});
  state = reduce(state, { type: 'binding/load', bindings: { keyboard: { actions: { throttle: ['KeyT'] } } } });
  assert(bindingCodes(state.bindings, 'throttle', 'keyboard').includes('KeyT'));
  assert(bindingCodes(state.bindings, 'brake', 'keyboard').includes('KeyS'), 'missing fields fall back');
  state = reduce(state, { type: 'binding/reset' });
  assert(bindingCodes(state.bindings, 'throttle', 'keyboard').includes('KeyW'));
  const normalized = normalizeBindings({ pad: { actions: { throttle: ['Bench'] } } });
  assert(!bindingCodes(normalized, 'throttle', 'pad').includes('Bench'), 'unknown pad button dropped');
});

await test('controls screen renders every action and a capture banner', () => {
  await withUi({ context: 'race' }, (ui) => {
    ui.open('controls');
    const rows = ui.element.querySelectorAll('[data-binding]');
    assertEqual(rows.length, 31);
    ui.dispatch({ type: 'binding/capture-start', action: 'throttle', device: 'keyboard' });
    const banner = ui.element.querySelector('[data-capture="throttle"]');
    assert(Boolean(banner), 'capture banner');
    assert(banner.textContent.includes('PRESS AN INPUT'));
  });
});

// --------------------------------------------------------------- diagnostics

await test('every error code builds a complete diagnostic', () => {
  const state = createUiState({
    context: 'race',
    mode: 'host',
    profileSettings: { quality: 'medium' },
    profile: { revision: 3 }
  });
  for (const code of Object.keys(ERROR_CATALOG)) {
    const diagnostic = buildDiagnostic(state, code, { httpStatus: 404 });
    assertEqual(diagnostic.schema, 'blur.ui-diagnostic');
    assertEqual(diagnostic.generator, 'ui-screens/1');
    assertEqual(diagnostic.code, code, code + ' code');
    assert(diagnostic.explanation.length > 10, code + ' explanation');
    assertEqual(diagnostic.settings.quality, 'medium');
    assertEqual(diagnostic.context, 'race');
    assertEqual(diagnostic.mode, 'host');
    assertEqual(diagnostic.pauseAuthority, 'host');
    assertEqual(diagnostic.roomContinues, true);
    assert(Array.isArray(diagnostic.notes) && diagnostic.notes.length === 2);
  }
});

await test('unknown error codes stay typed and honest', () => {
  const resolved = resolveError('SOMETHING_NEW');
  assertEqual(resolved.code, 'UNKNOWN_ERROR');
  assertEqual(resolved.requestedCode, 'SOMETHING_NEW');
  assertEqual(resolved.known, false);
  const diagnostic = buildDiagnostic(createUiState({}), 'SOMETHING_NEW');
  assertEqual(diagnostic.code, 'UNKNOWN_ERROR');
  assertEqual(diagnostic.requestedCode, 'SOMETHING_NEW');
});

await test('diagnostic redaction removes secrets and personal data', () => {
  const redacted = redactDiagnostics({
    token: 'abc',
    password: 'hunter2',
    cookie: 'sid=1',
    apiKey: 'k',
    playerName: 'Alice',
    email: 'a@b.c',
    safe: 'value',
    nested: { authorization: 'Bearer xyz', count: 3 },
    list: [{ secret: 'x' }, 4]
  });
  assertEqual(redacted.token, '<redacted>');
  assertEqual(redacted.password, '<redacted>');
  assertEqual(redacted.cookie, '<redacted>');
  assertEqual(redacted.apiKey, '<redacted>');
  assertEqual(redacted.playerName, '<redacted>');
  assertEqual(redacted.email, '<redacted>');
  assertEqual(redacted.safe, 'value');
  assertEqual(redacted.nested.authorization, '<redacted>');
  assertEqual(redacted.nested.count, 3);
  assertEqual(redacted.list[0].secret, '<redacted>');
  assertEqual(redacted.list[1], 4);
});

await test('text sanitisation removes paths and bearer values', () => {
  const text = sanitizeText('failed C:\\Users\\someone\\game\\map.json with Bearer abc.def?token=secret');
  assert(text.includes('<path>'), 'path removed');
  assert(text.includes('<redacted>'), 'bearer removed');
  assert(!text.includes('C:\\Users'), 'windows path gone');
  assert(!text.includes('abc.def'), 'bearer gone');
  assertEqual(sanitizeText('x'.repeat(500)).endsWith('…'), true);
  assertEqual(sanitizeText(null), null);
});

await test('diagnostic JSON is deterministic and sorted', () => {
  const state = createUiState({ context: 'race', mode: 'solo' });
  const a = diagnosticText(buildDiagnostic(state, 'NETWORK_LOST', null));
  const b = diagnosticText(buildDiagnostic(state, 'NETWORK_LOST', null));
  assertEqual(a, b);
  const parsed = JSON.parse(a);
  assertEqual(parsed.code, 'NETWORK_LOST');
  const keys = Object.keys(parsed);
  assertEqual(keys.join(','), [...keys].sort().join(','), 'top-level keys sorted');
});

await test('diagnostic includes room, missing capabilities and detail', () => {
  let state = createUiState({ context: 'race', mode: 'guest' });
  state = reduce(state, { type: 'connection/lost', code: 'NETWORK_TIMEOUT', roomCode: 'K7M2Q', latencyMs: 120 });
  state = reduce(state, { type: 'browser/show', missing: ['BROWSER_NO_WEBGPU'] });
  const diagnostic = buildDiagnostic(state, 'NETWORK_TIMEOUT', { attempt: 2 });
  assertEqual(diagnostic.roomCode, 'K7M2Q');
  assertEqual(diagnostic.missing.join(','), 'BROWSER_NO_WEBGPU');
  assertEqual(diagnostic.contextData.attempt, 2);
});

await test('classifyBrowser reports every missing requirement', () => {
  const all = classifyBrowser({ webgpu: true, secureContext: true, cryptoSubtle: true, wasm: true, modules: true });
  assertEqual(all.ok, true);
  assertEqual(all.code, 'BROWSER_UNSUPPORTED');
  assertEqual(all.missing.length, 0);
  const noGpu = classifyBrowser({ webgpu: false });
  assertEqual(noGpu.missing.join(','), 'BROWSER_NO_WEBGPU');
  assertEqual(noGpu.code, 'BROWSER_NO_WEBGPU');
  const multi = classifyBrowser({ webgpu: false, wasm: false });
  assertEqual(multi.code, 'BROWSER_UNSUPPORTED');
  assertEqual(multi.missing.length, 2);
  const memory = classifyBrowser({ memoryBytes: 1024 });
  assertEqual(memory.missing.join(','), 'WASM_MEMORY_LIMIT');
  const features = classifyBrowser({ missingWasmFeatures: ['simd'] });
  assertEqual(features.missing.join(','), 'WASM_FEATURE_MISSING');
});

await test('error details render code, explanation and copyable block', () => {
  await withUi({ context: 'race' }, (ui) => {
    ui.open('error-details', {
      code: 'ASSET_LOAD_FAILED',
      detail: 'fetch failed C:\\Users\\x\\map.json',
      context: { httpStatus: 404 }
    });
    assert(ui.element.textContent.includes('ASSET_LOAD_FAILED'));
    assert(ui.element.textContent.includes('A game file could not be loaded'));
    const pre = ui.element.querySelector('#uis-diagnostic');
    assert(Boolean(pre), 'diagnostic pre exists');
    assertEqual(pre.getAttribute('tabindex'), '0');
    assert(pre.textContent.includes('"code": "ASSET_LOAD_FAILED"'));
    assert(!pre.textContent.includes('C:\\Users'), 'path sanitised');
    assert(ui.element.querySelector('[data-focus="error-copy"]'), 'copy button');
  });
});

await test('copy uses the injected clipboard and emits a copy event', async () => {
  let copied = null;
  const { document, host } = createHost();
  const ui = mountUiScreens(host, {
    context: 'race',
    document,
    copyText: async (text) => { copied = text; return true; }
  });
  const events = [];
  ui.on('copy', (event) => events.push(event));
  ui.open('error-details', { code: 'NETWORK_LOST' });
  await ui.copyDiagnostic('{"a":1}');
  await Promise.resolve();
  assertEqual(copied, '{"a":1}');
  assertEqual(events.length, 1);
  assertEqual(events[0].ok, true);
  assertEqual(events[0].kind, 'diagnostic');
  assert(events[0].hash.startsWith('fnv1a32:'));
  ui.destroy();
});

await test('copy failure is reported, not hidden', async () => {
  const { document, host } = createHost();
  const ui = mountUiScreens(host, { context: 'race', document, copyText: async () => false });
  const events = [];
  ui.on('copy', (event) => events.push(event));
  await ui.copyDiagnostic('x');
  await Promise.resolve();
  assertEqual(events[0].ok, false);
  ui.destroy();
});

await test('retryable errors render a retry action', () => {
  return withUi({ context: 'race' }, (ui) => {
    ui.open('error-details', { code: 'ASSET_LOAD_FAILED' });
    const retry = ui.element.querySelector('[data-focus="error-retry"]');
    assert(Boolean(retry), 'retry button');
    retry.click();
    const effect = ui.state().effects.find((entry) => entry.type === 'error-retry');
    assertEqual(effect.code, 'ASSET_LOAD_FAILED');
    ui.open('error-details', { code: 'PROFILE_READ_ONLY' });
    assertEqual(ui.element.querySelector('[data-focus="error-retry"]'), null, 'non-retryable has no retry');
  });
});

await test('connection screen renders retry, cancel and room facts', () => {
  await withUi({ context: 'race', mode: 'host' }, (ui) => {
    ui.dispatch({ type: 'connection/lost', code: 'NETWORK_LOST', roomCode: 'K7M2Q', latencyMs: 88 });
    assert(ui.element.textContent.includes('K7M2Q'));
    assert(ui.element.textContent.includes('88 ms'));
    assert(ui.element.querySelector('[data-focus="connection-retry"]'));
    assert(ui.element.querySelector('[data-focus="connection-cancel"]'));
    ui.element.querySelector('[data-focus="connection-retry"]').click();
    assertEqual(ui.state().connection.attempt, 1);
  });
});

await test('version mismatch screen renders both versions', () => {
  await withUi({ context: 'menu' }, (ui) => {
    ui.dispatch({ type: 'version/show', expected: '2', actual: '1', kind: 'room' });
    assert(ui.element.textContent.includes('EXPECTED'));
    assert(ui.element.textContent.includes('THIS BUILD'));
    assert(ui.element.textContent.includes('2'));
    assert(ui.element.textContent.includes('1'));
    assert(ui.element.querySelector('[data-focus="version-back"]'));
  });
});

// ----------------------------------------------------- gamepad + a11y + a11y

await test('gamepad intents are edge-triggered', () => {
  assertEqual(gamepadIntent([true], [], {}), 'confirm');
  assertEqual(gamepadIntent([true], [], { buttons: [true] }), null);
  assertEqual(gamepadIntent([false, true], [], {}), 'back');
  const start = [];
  start[9] = true;
  assertEqual(gamepadIntent(start, [], {}), 'pause');
  assertEqual(gamepadIntent([], [0, -0.9], { axes: [0, 0] }), 'up');
  assertEqual(gamepadIntent([], [0, -0.9], { axes: [0, -0.9] }), null);
});

await test('navigation helpers clamp and wrap', () => {
  assertEqual(nextFocusIndex(0, 4, 'ArrowRight'), 1);
  assertEqual(nextFocusIndex(3, 4, 'ArrowRight'), 3);
  assertEqual(nextFocusIndex(0, 4, 'ArrowLeft'), 0);
  assertEqual(nextFocusIndex(1, 4, 'ArrowDown', 2), 3);
  assertEqual(nextFocusIndex(3, 4, 'ArrowDown', 2), 3);
  assertEqual(nextFocusIndex(0, 4, 'End'), 3);
  assertEqual(trapFocusIndex(3, 4, false), 0);
  assertEqual(trapFocusIndex(0, 4, true), 3);
  assertEqual(trapFocusIndex(1, 4, false), 2);
  assertEqual(navigateFocus(-1, 4, 'up'), 0);
  assertEqual(navigateFocus(0, 0, 'down'), -1);
});

await test('renderer handles gamepad navigation and confirm', () => {
  return withUi({ context: 'race' }, (ui, document) => {
    ui.open('pause');
    ui.handleGamepad({ connected: true, buttons: [], axes: [0, 0] });
    const down = [];
    down[13] = true;
    assertEqual(ui.handleGamepad({ connected: true, buttons: down, axes: [0, 0] }), 'down');
    assert(document.activeElement.dataset.focus === 'pause-settings', 'moved to next action');
    const confirm = [];
    confirm[0] = true;
    ui.handleGamepad({ connected: true, buttons: confirm, axes: [0, 0] });
    assertEqual(ui.state().stack.length, 2, 'A confirmed settings');
  });
});

await test('gamepad Start outside a screen only requests pause', () => {
  return withUi({ context: 'race' }, (ui) => {
    let requests = 0;
    ui.on('pause-requested', () => { requests += 1; });
    const start = [];
    start[9] = true;
    ui.handleGamepad({ connected: true, buttons: start, axes: [0, 0] });
    assertEqual(requests, 1);
    assert(!isOpen(ui.state()), 'renderer never opens pause itself');
  });
});

await test('pad capture consumes the first pressed button', () => {
  return withUi({ context: 'race' }, (ui) => {
    ui.open('controls');
    ui.dispatch({ type: 'binding/capture-start', action: 'throttle', device: 'pad' });
    const buttons = [];
    buttons[2] = true;
    ui.handleGamepad({ connected: true, buttons, axes: [0, 0] });
    assert(bindingCodes(ui.state().bindings, 'throttle', 'pad').includes('X'));
  });
});

await test('every form control has an accessible name', () => {
  return withUi({ context: 'race' }, (ui) => {
    ui.open('settings');
    const controls = ui.element.querySelectorAll('input, select');
    assert(controls.length >= 12);
    for (const control of controls) {
      const label = control.getAttribute('aria-label');
      assert(label && label.length > 2, 'control needs aria-label: ' + control.id);
    }
  });
});

await test('labels, progressbar and group semantics are present', () => {
  return withUi({ context: 'race' }, (ui) => {
    ui.open('settings');
    assertEqual(ui.element.querySelectorAll('fieldset').length, SETTINGS_SECTIONS.length);
    assert(ui.element.querySelectorAll('label').length >= 12);
    ui.close();
    ui.open('loading', { label: 'Verifying', progress: 0.5 });
    const bar = ui.element.querySelector('[role="progressbar"]');
    assertEqual(bar.getAttribute('aria-valuenow'), '50');
    assertEqual(bar.getAttribute('aria-valuemax'), '100');
    assertEqual(bar.getAttribute('aria-label'), 'Verifying');
  });
});

await test('reduced motion is carried on the root and in CSS', () => {
  return withUi({ context: 'race', reducedMotion: true }, (ui) => {
    assertEqual(ui.element.dataset.reducedMotion, 'true');
    const css = readFileSync(new URL('./screens.css', import.meta.url), 'utf8');
    assert(css.includes('prefers-reduced-motion'), 'media query');
    assert(css.includes('data-reduced-motion="true"'), 'root switch');
    assert(css.includes('forced-colors: active'), 'forced colors');
    assert(css.includes(':focus-visible'), 'focus-visible');
  });
});

await test('unsupported browser screen lists typed codes', () => {
  return withUi({ context: 'boot' }, (ui) => {
    ui.dispatch({ type: 'browser/show', missing: ['BROWSER_NO_WEBGPU', 'BROWSER_NO_CRYPTO_SUBTLE'] });
    assert(ui.element.textContent.includes('BROWSER_NO_WEBGPU'));
    assert(ui.element.textContent.includes('BROWSER_NO_CRYPTO_SUBTLE'));
    const details = ui.element.querySelector('[data-focus="browser-details"]');
    assert(Boolean(details));
    const continueButton = ui.element.querySelector('[data-focus="browser-continue"]');
    assertEqual(continueButton.disabled, true, 'continue disabled by default');
    details.click();
    assertEqual(activeScreen(ui.state()).id, 'error-details');
  });
});

await test('unsupported browser can allow a degraded start explicitly', () => {
  return withUi({ context: 'boot' }, (ui) => {
    ui.dispatch({ type: 'browser/show', missing: ['BROWSER_NO_WEBGPU'], allowContinue: true });
    const continueButton = ui.element.querySelector('[data-focus="browser-continue"]');
    assertEqual(continueButton.disabled, false);
  });
});

await test('pause screen in multiplayer says the room continues', () => {
  return withUi({ context: 'race', mode: 'guest' }, (ui) => {
    ui.open('pause');
    assert(ui.element.textContent.includes('ROOM CONTINUES'));
    assert(ui.element.textContent.includes('host'));
    assertEqual(ui.element.dataset.paused, 'false');
    assertEqual(ui.element.querySelector('#uis-title').textContent, 'Session menu');
    assert(ui.element.querySelector('[data-focus="pause-quit"]').textContent.includes('LEAVE ROOM'));
  });
});

// ---------------------------------------------------------------- snapshots

await test('snapshot states cover every screen deterministically', () => {
  const states = snapshotStates();
  assertEqual(states.length, 10);
  assertEqual(states.map((entry) => entry.name).join(','),
    'pause-solo,pause-multiplayer,settings,controls,loading,connection-lost,version-mismatch,unsupported-browser,confirm-quit,error-details');
  assertEqual(states[0].state.paused, true);
  assertEqual(states[1].state.paused, false);
  assertEqual(states[1].state.mode, 'guest');
  assertEqual(states[2].state.stack.slice(-1)[0].id, 'settings');
  assertEqual(states[3].state.capture.action, 'throttle');
  assertEqual(states[4].state.screen ?? activeScreen(states[4].state)?.id, 'loading');
  assertEqual(states[5].state.connection.code, 'NETWORK_LOST');
  assertEqual(states[6].state.versionInfo.kind, 'room');
  assertEqual(states[7].state.browser.missing.length, 2);
  assertEqual(states[8].state.confirmQuit.target, 'menu');
  assertEqual(states[9].state.error.code, 'ASSET_LOAD_FAILED');
  assert(states.every((entry) => Array.isArray(entry.state.effects) && entry.state.effects.length === 0), 'no effects in snapshots');
});

await test('snapshot report hash is stable and serialisable', () => {
  const a = snapshotReport();
  const b = snapshotReport();
  assertEqual(a.hash, b.hash);
  assert(a.hash.startsWith('fnv1a32:'));
  assertEqual(a.hash.length, 'fnv1a32:'.length + 8);
  assertEqual(canonicalJson(a), canonicalJson(b));
  const parsed = JSON.parse(canonicalJson(a));
  assertEqual(parsed.schema, 'blur.ui-screens.snapshots');
  assertEqual(parsed.states.length, 10);
});

// -------------------------------------------------------------------- report

const total = cases.length;
const failed = failures.length;
const report = {
  schema: 'blur.ui-screens.tests',
  version: 1,
  cases: total,
  passed: total - failed,
  failed,
  assertions,
  passedAssertions,
  failedAssertions: assertions - passedAssertions,
  results: cases,
  failures
};
report.hash = fnv1a32(canonicalJson(report));

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const outDir = join(root, '_work', 'ui-screens');
const logDir = join(root, '_work', 'logs', 'ui-screens');
mkdirSync(outDir, { recursive: true });
mkdirSync(logDir, { recursive: true });
writeFileSync(join(outDir, 'tests.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
writeFileSync(join(outDir, 'snapshots.json'), JSON.stringify(snapshotReport(), null, 2) + '\n', 'utf8');

const line = 'ui-screens: ' + report.cases + ' cases, ' + report.assertions + ' assertions, ' +
  report.passed + ' passed, ' + report.failed + ' failed, hash ' + report.hash;
writeFileSync(join(logDir, 'ui-tests.log'), line + '\n', 'utf8');
console.log(line);
for (const failure of failures) console.error('FAIL ' + failure.name + ': ' + failure.error);
if (failures.length) process.exitCode = 1;
