/**
 * Blur Web — UI screens state machine, settings model and diagnostics.
 *
 * Framework-free and DOM-free. `screens.js` renders this module; the Node test
 * suite drives every transition without a browser.
 *
 * Scope and honesty rules:
 *  - Retail Blur pause/settings/help art and layout were **not** decoded. Every
 *    screen def carries `retailDerived:false`, and the renderer shows the note.
 *  - Settings that exist in the profile store v1 schema are consumed read-only:
 *    this module never mutates a profile document. It emits a patch that the
 *    owner applies through `updateSettings()`.
 *  - Display resolution scale, vsync and language are project extensions and
 *    live in `blur.ui.local.v1`; they are labelled "project".
 *  - No value is guessed. An unsupported browser capability, an unknown error
 *    code or an unknown setting is reported with a typed reason.
 *
 * The action list for remapping comes from INPUT1 (`probes/input/input.mjs`).
 */

import {
  ACTIONS,
  ACTION_IDS,
  PAD_BUTTON_INDEX,
  PAD_BUTTON_NAMES,
  createDefaultBindings
} from '../input/input.mjs';

export const UI_SCREENS_VERSION = 1;
export const UI_SCHEMA = 'blur.ui-screens';
export const UI_LOCAL_SETTINGS_KEY = 'blur.ui.local.v1';
export const UI_LOCAL_SETTINGS_VERSION = 1;

/** Every screen this module can render. `null` means "no overlay". */
export const SCREEN_IDS = Object.freeze([
  'pause',
  'settings',
  'controls',
  'loading',
  'connection-lost',
  'version-mismatch',
  'unsupported-browser',
  'confirm-quit',
  'error-details'
]);

export const PROJECT_LAYOUT_NOTE =
  'Project layout — retail Blur menu art and screen layout were not decoded.';

export const SCREEN_DEFS = Object.freeze({
  pause: Object.freeze({
    id: 'pause',
    title: 'Paused',
    eyebrow: 'SESSION',
    description: 'Resume, open settings or leave the current session.',
    closeLabel: 'RESUME',
    dismissible: true,
    blocksSimulation: 'solo-only',
    retailDerived: false
  }),
  settings: Object.freeze({
    id: 'settings',
    title: 'Settings',
    eyebrow: 'OPTIONS',
    description: 'Profile values are written through the profile store; display options are project-only.',
    closeLabel: 'BACK',
    dismissible: true,
    blocksSimulation: 'solo-only',
    retailDerived: false
  }),
  controls: Object.freeze({
    id: 'controls',
    title: 'Controls',
    eyebrow: 'INPUT',
    description: 'Keyboard and gamepad bindings from the INPUT1 action table.',
    closeLabel: 'BACK',
    dismissible: true,
    blocksSimulation: 'solo-only',
    retailDerived: false
  }),
  loading: Object.freeze({
    id: 'loading',
    title: 'Loading',
    eyebrow: 'NETWORK',
    description: 'Waiting for the host, map pins or the engine module.',
    closeLabel: 'CANCEL',
    dismissible: true,
    blocksSimulation: 'none',
    retailDerived: false
  }),
  'connection-lost': Object.freeze({
    id: 'connection-lost',
    title: 'Connection lost',
    eyebrow: 'NETWORK',
    description: 'The room socket closed. Retry to reconnect or cancel to leave.',
    closeLabel: 'CANCEL',
    dismissible: true,
    blocksSimulation: 'none',
    retailDerived: false
  }),
  'version-mismatch': Object.freeze({
    id: 'version-mismatch',
    title: 'Version mismatch',
    eyebrow: 'COMPATIBILITY',
    description: 'The room or save was written by a different build.',
    closeLabel: 'BACK',
    dismissible: true,
    blocksSimulation: 'none',
    retailDerived: false
  }),
  'unsupported-browser': Object.freeze({
    id: 'unsupported-browser',
    title: 'Unsupported browser',
    eyebrow: 'COMPATIBILITY',
    description: 'A required browser capability is missing.',
    closeLabel: 'BACK',
    dismissible: true,
    blocksSimulation: 'none',
    retailDerived: false
  }),
  'confirm-quit': Object.freeze({
    id: 'confirm-quit',
    title: 'Confirm quit',
    eyebrow: 'CONFIRM',
    description: 'Leaving a room or a race cannot be undone.',
    closeLabel: 'CANCEL',
    dismissible: true,
    blocksSimulation: 'solo-only',
    retailDerived: false
  }),
  'error-details': Object.freeze({
    id: 'error-details',
    title: 'Error details',
    eyebrow: 'DIAGNOSTICS',
    description: 'Typed code, human explanation and a copyable diagnostic block.',
    closeLabel: 'CLOSE',
    dismissible: true,
    blocksSimulation: 'solo-only',
    retailDerived: false
  })
});

/** Which screens may be pushed on top of which. Error details is universal. */
export const OPEN_CHILDREN = Object.freeze({
  pause: Object.freeze(['settings', 'controls', 'confirm-quit', 'error-details']),
  settings: Object.freeze(['controls', 'confirm-quit', 'error-details']),
  controls: Object.freeze(['error-details']),
  loading: Object.freeze(['confirm-quit', 'error-details']),
  'connection-lost': Object.freeze(['confirm-quit', 'error-details']),
  'version-mismatch': Object.freeze(['error-details']),
  'unsupported-browser': Object.freeze(['error-details']),
  'confirm-quit': Object.freeze(['error-details']),
  'error-details': Object.freeze([])
});

// ---------------------------------------------------------------------------
// Error catalog. Every entry has a stable typed code, a human explanation, a
// severity and a declared action. No entry invents a retail message.
// ---------------------------------------------------------------------------

function errorEntry(code, title, explanation, options = {}) {
  return Object.freeze({
    code,
    title,
    explanation,
    severity: options.severity ?? 'error',
    retryable: options.retryable === true,
    action: options.action ?? (options.retryable ? 'Retry' : 'Close'),
    source: options.source ?? 'project',
    profileCode: options.profileCode ?? null,
    diagnosticHint: options.diagnosticHint ?? null
  });
}

export const ERROR_CATALOG = Object.freeze({
  BROWSER_UNSUPPORTED: errorEntry(
    'BROWSER_UNSUPPORTED',
    'This browser cannot run the game',
    'The page needs WebGPU, module scripts, WebAssembly and secure-context crypto. One or more are missing.',
    { action: 'View details', source: 'compat/requirements.json' }
  ),
  BROWSER_NO_WEBGPU: errorEntry(
    'BROWSER_NO_WEBGPU',
    'WebGPU is not available',
    'The renderer is WebGPU-only. navigator.gpu was not found or no adapter could be created.',
    { source: 'compat/requirements.json:webgpu', diagnosticHint: 'Enable WebGPU or use a supported Chromium/Edge build over https or localhost.' }
  ),
  BROWSER_NO_SECURE_CONTEXT: errorEntry(
    'BROWSER_NO_SECURE_CONTEXT',
    'A secure context is required',
    'WebGPU and crypto.subtle are only exposed on https or localhost.',
    { source: 'compat/requirements.json:webApis' }
  ),
  BROWSER_NO_CRYPTO_SUBTLE: errorEntry(
    'BROWSER_NO_CRYPTO_SUBTLE',
    'SHA-256 verification is unavailable',
    'crypto.subtle.digest is required to verify map and car bytes before a race.',
    { source: 'compat/requirements.json:webApis' }
  ),
  BROWSER_NO_WASM: errorEntry(
    'BROWSER_NO_WASM',
    'WebAssembly is not available',
    'The vehicle physics, race rules and render packet producer run in wasm.',
    { source: 'compat/requirements.json:wasm' }
  ),
  WASM_FEATURE_MISSING: errorEntry(
    'WASM_FEATURE_MISSING',
    'The wasm build needs a missing feature',
    'The committed module requires mvp, mutable-globals, sign-ext, bulk-memory and nontrapping-fptoint.',
    { source: 'compat/requirements.json:wasm.featuresRequired' }
  ),
  WASM_MEMORY_LIMIT: errorEntry(
    'WASM_MEMORY_LIMIT',
    'Not enough wasm memory',
    'The drive module starts with 256 MiB and may grow to 512 MiB. The device refused the allocation.',
    { source: 'compat/requirements.json:wasm.memoryNote' }
  ),
  MODULE_UNSUPPORTED: errorEntry(
    'MODULE_UNSUPPORTED',
    'ES modules are unsupported',
    'The page entry is a module script and the Emscripten glue uses top-level await.',
    { source: 'compat/requirements.json:javascript' }
  ),
  ASSET_LOAD_FAILED: errorEntry(
    'ASSET_LOAD_FAILED',
    'A game file could not be loaded',
    'A map chunk, car chunk, layout or texture fetch failed. The race did not start with a substitute asset.',
    { retryable: true }
  ),
  MAP_HASH_MISMATCH: errorEntry(
    'MAP_HASH_MISMATCH',
    'Map verification failed',
    'The fetched map bytes do not match the committed SHA-256 pin, so the map was rejected.',
    { source: 'MP8 map package rule' }
  ),
  MAP_PACKAGE_MISMATCH: errorEntry(
    'MAP_PACKAGE_MISMATCH',
    'Room map packages differ',
    'The host and guest loaded different map package, layout or physics hashes.',
    { source: 'MP8' }
  ),
  RACE_LOAD_TIMEOUT: errorEntry(
    'RACE_LOAD_TIMEOUT',
    'The race did not become ready',
    'The engine did not report ready before the loading timeout.',
    { retryable: true }
  ),
  NETWORK_LOST: errorEntry(
    'NETWORK_LOST',
    'The room connection dropped',
    'The WebSocket to the room service closed. The local simulation stopped at the last snapshot.',
    { retryable: true, source: 'net-mvp' }
  ),
  NETWORK_TIMEOUT: errorEntry(
    'NETWORK_TIMEOUT',
    'The room did not answer',
    'No snapshot or lobby message arrived within the timeout.',
    { retryable: true, source: 'net-mvp' }
  ),
  ROOM_NOT_FOUND: errorEntry(
    'ROOM_NOT_FOUND',
    'That room does not exist',
    'The room code was not present on the room service. Codes are 5 characters from the room alphabet.',
    { source: 'net-mvp' }
  ),
  ROOM_FULL: errorEntry(
    'ROOM_FULL',
    'That room is full',
    'The room already has the maximum number of human players.',
    { source: 'net-mvp' }
  ),
  ROOM_HOST_LEFT: errorEntry(
    'ROOM_HOST_LEFT',
    'The host left the room',
    'The room is host-authoritative; without the host the race cannot continue.',
    { source: 'M1 host authority' }
  ),
  VERSION_MISMATCH: errorEntry(
    'VERSION_MISMATCH',
    'Build versions do not match',
    'The room protocol or profile schema was written by a different build. Nothing was overwritten.',
    { source: 'profile-store §future-schema' }
  ),
  PROFILE_READ_ONLY: errorEntry(
    'PROFILE_READ_ONLY',
    'The profile is read-only',
    'The profile could not be recovered safely, so settings changes will not be saved over it.',
    { action: 'Backup / Reset', profileCode: 'read-only', source: 'profile contract' }
  ),
  PROFILE_QUOTA_EXCEEDED: errorEntry(
    'PROFILE_QUOTA_EXCEEDED',
    'Progress could not be saved',
    'Browser storage is full. The current session keeps the new values.',
    { retryable: true, profileCode: 'quota-exceeded', source: 'profile contract' }
  ),
  PROFILE_CORRUPT: errorEntry(
    'PROFILE_CORRUPT',
    'The saved profile was damaged',
    'The damaged bytes were backed up before a fresh profile was written.',
    { severity: 'warning', profileCode: 'corrupt-json', source: 'profile contract' }
  ),
  AUDIO_UNAVAILABLE: errorEntry(
    'AUDIO_UNAVAILABLE',
    'Engine audio is unavailable',
    'The AudioContext or the retail engine loops could not be started. Driving continues silently.',
    { severity: 'warning', source: 'audio-feasibility' }
  ),
  INPUT_BINDING_CONFLICT: errorEntry(
    'INPUT_BINDING_CONFLICT',
    'That input is already bound',
    'The same key or pad button is used by another action in the same context. The old binding was kept.',
    { severity: 'warning', action: 'Choose another input', source: 'input.mjs findConflicts' }
  ),
  UNKNOWN_ERROR: errorEntry(
    'UNKNOWN_ERROR',
    'An unclassified error occurred',
    'No catalog entry exists for the reported code. The raw code and context are kept for a report.',
    { action: 'Copy diagnostics' }
  )
});

export function resolveError(code) {
  const requested = typeof code === 'string' && code ? code : 'UNKNOWN_ERROR';
  const entry = ERROR_CATALOG[requested] ?? ERROR_CATALOG.UNKNOWN_ERROR;
  return { ...entry, requestedCode: requested, known: Boolean(ERROR_CATALOG[requested]) };
}

// ---------------------------------------------------------------------------
// Settings schema. Profile entries are exact paths in blur.profile.v1.
// ---------------------------------------------------------------------------

function field(path, label, type, options = {}) {
  return Object.freeze({
    path,
    label,
    type,
    scope: options.scope ?? 'profile',
    section: options.section ?? 'general',
    values: options.values ? Object.freeze([...options.values]) : null,
    min: options.min ?? null,
    max: options.max ?? null,
    step: options.step ?? null,
    decimals: options.decimals ?? null,
    default: options.default,
    readOnly: options.readOnly === true,
    retailDerived: options.retailDerived !== false,
    apply: options.apply ?? null,
    help: options.help ?? null
  });
}

export const SETTINGS_SECTIONS = Object.freeze([
  { id: 'graphics', label: 'Graphics & display', note: 'Quality is a profile value; resolution scale and vsync are project-only.' },
  { id: 'audio', label: 'Audio', note: 'Volume and mute are profile values; the engine audio module applies them.' },
  { id: 'camera', label: 'Camera & input', note: 'Camera and steering are profile values. Bindings are owned by INPUT1.' },
  { id: 'hud', label: 'HUD', note: 'HUD visibility and units are profile values.' },
  { id: 'language', label: 'Language', note: 'Locales are the shipped .loc set; the selector itself is a project screen.' }
]);

export const SETTINGS_SCHEMA = Object.freeze([
  field('quality', 'Graphics quality', 'enum', {
    section: 'graphics', values: ['low', 'medium', 'high', 'ultra'], default: 'high',
    apply: 'quality-preset',
    help: 'Profile quality preset. Renderer mips/aliasing are P75; a preset must map to real switches before it claims a visual change.'
  }),
  field('display.resolutionScale', 'Resolution scale', 'enum', {
    section: 'graphics', values: ['auto', '0.75', '1', '1.25', '1.5', '2'], default: 'auto',
    scope: 'local', retailDerived: false, apply: 'render-scale',
    help: 'Project option. The canvas backing store is scaled by this factor; auto follows devicePixelRatio 1..2.'
  }),
  field('display.vsync', 'Vertical sync', 'boolean', {
    section: 'graphics', default: true, scope: 'local', retailDerived: false, apply: 'present-mode',
    help: 'Project option. WebGPU canvases do not expose a vsync switch; the host maps false to an uncapped rAF loop only if its backend supports it.'
  }),
  field('volumes.master', 'Master volume', 'number', {
    section: 'audio', min: 0, max: 1, step: 0.01, decimals: 3, default: 0.8, apply: 'audio-master'
  }),
  field('volumes.music', 'Music volume', 'number', {
    section: 'audio', min: 0, max: 1, step: 0.01, decimals: 3, default: 0.5, apply: 'audio-music'
  }),
  field('volumes.sfx', 'Effects volume', 'number', {
    section: 'audio', min: 0, max: 1, step: 0.01, decimals: 3, default: 0.8, apply: 'audio-sfx'
  }),
  field('muted', 'Mute all audio', 'boolean', {
    section: 'audio', default: false, apply: 'audio-mute'
  }),
  field('cameraMode', 'Camera mode', 'enum', {
    section: 'camera', values: ['chase', 'orbit'], default: 'chase', apply: 'camera-mode',
    help: 'Profile enum. The drive page also exposes drag-to-orbit; chase is the default.'
  }),
  field('steer', 'Steering direction', 'enum', {
    section: 'camera', values: ['normal', 'inverted'], default: 'normal', apply: 'steer-sign'
  }),
  field('inputBindingsRef', 'Binding table', 'string', {
    section: 'camera', default: 'default-keyboard-v1', readOnly: true,
    help: 'Profile stores a binding-table id, not the table. Use Controls to change the live bindings.'
  }),
  field('hud.showSpeed', 'Show speed', 'boolean', {
    section: 'hud', default: true, apply: 'hud-speed'
  }),
  field('hud.showGhostDelta', 'Show ghost delta', 'boolean', {
    section: 'hud', default: true, apply: 'hud-ghost-delta'
  }),
  field('hud.showMinimap', 'Show minimap', 'boolean', {
    section: 'hud', default: false, apply: 'hud-minimap'
  }),
  field('hud.units', 'Units', 'enum', {
    section: 'hud', values: ['metric', 'imperial'], default: 'metric', apply: 'hud-units'
  }),
  field('language', 'Language', 'enum', {
    section: 'language', values: ['en', 'fr', 'de', 'it', 'es'], default: 'en',
    scope: 'local', retailDerived: false, apply: 'locale',
    help: 'Project selector over the shipped .loc locales (en, fr, de, it, es). Missing strings stay typed missing.'
  })
]);

export const PROFILE_SETTINGS_SCHEMA = Object.freeze(
  SETTINGS_SCHEMA.filter((entry) => entry.scope === 'profile'));
export const LOCAL_SETTINGS_SCHEMA = Object.freeze(
  SETTINGS_SCHEMA.filter((entry) => entry.scope === 'local'));
export const SETTINGS_BY_PATH = Object.freeze(
  Object.fromEntries(SETTINGS_SCHEMA.map((entry) => [entry.path, entry])));

const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

function splitPath(path) {
  if (typeof path !== 'string' || !path) return null;
  const parts = path.split('.');
  if (parts.some((part) => !part || FORBIDDEN_SEGMENTS.has(part))) return null;
  return parts;
}

function readPath(object, path) {
  const parts = splitPath(path);
  if (!parts) return undefined;
  let cursor = object;
  for (const part of parts) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

function writePath(object, path, value) {
  const parts = splitPath(path);
  if (!parts) return object;
  const root = { ...(object ?? {}) };
  let cursor = root;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const key = parts[index];
    const child = cursor[key];
    cursor[key] = child && typeof child === 'object' && !Array.isArray(child) ? { ...child } : {};
    cursor = cursor[key];
  }
  cursor[parts[parts.length - 1]] = value;
  return root;
}

export function validateSettingValue(fieldDef, value) {
  if (!fieldDef) return { ok: false, reason: 'unknown-field' };
  if (fieldDef.readOnly) return { ok: false, reason: 'read-only' };
  if (fieldDef.type === 'enum') {
    return fieldDef.values.includes(value)
      ? { ok: true, value }
      : { ok: false, reason: 'not-in-enum', allowed: fieldDef.values };
  }
  if (fieldDef.type === 'boolean') {
    if (value === true || value === false) return { ok: true, value };
    return { ok: false, reason: 'not-boolean' };
  }
  if (fieldDef.type === 'number') {
    let number = value;
    if (typeof number === 'string' && number.trim() !== '') number = Number(number);
    if (typeof number !== 'number' || !Number.isFinite(number)) {
      return { ok: false, reason: 'not-a-finite-number' };
    }
    if (fieldDef.min !== null && number < fieldDef.min) {
      return { ok: false, reason: 'below-minimum', min: fieldDef.min };
    }
    if (fieldDef.max !== null && number > fieldDef.max) {
      return { ok: false, reason: 'above-maximum', max: fieldDef.max };
    }
    if (fieldDef.decimals !== null) {
      const factor = 10 ** fieldDef.decimals;
      number = Math.round(number * factor) / factor;
    }
    return { ok: true, value: number };
  }
  if (fieldDef.type === 'string') {
    if (typeof value !== 'string' || !value.trim()) return { ok: false, reason: 'not-a-non-empty-string' };
    return { ok: true, value: value.trim() };
  }
  return { ok: false, reason: 'unsupported-type' };
}

/** Defaults for the whole settings model (profile + local). */
export function defaultSettings() {
  const values = {};
  for (const entry of SETTINGS_SCHEMA) values[entry.path] = entry.default;
  return values;
}

/**
 * Read settings from a profile document section. The profile is never mutated.
 * Unknown or invalid values fall back to the documented default and are listed
 * in `issues`; a newer schema is reported `readOnly`.
 */
export function settingsFromProfile(profileSettings, options = {}) {
  const values = defaultSettings();
  const issues = [];
  const readOnly = options.readOnly === true || options.schemaVersion > 1;
  if (profileSettings && typeof profileSettings === 'object') {
    for (const entry of PROFILE_SETTINGS_SCHEMA) {
      if (entry.readOnly) {
        const raw = readPath(profileSettings, entry.path);
        if (typeof raw === 'string' && raw) values[entry.path] = raw;
        continue;
      }
      const raw = readPath(profileSettings, entry.path);
      if (raw === undefined) continue;
      const check = validateSettingValue({ ...entry, readOnly: false }, raw);
      if (check.ok) values[entry.path] = check.value;
      else issues.push({ path: entry.path, reason: check.reason, kept: entry.default });
    }
  }
  return { values, issues, readOnly };
}

export function settingsValuesToProfilePatch(values, baseline = defaultSettings()) {
  const patch = {};
  const changed = [];
  for (const entry of PROFILE_SETTINGS_SCHEMA) {
    if (entry.readOnly) continue;
    const next = readPath(values, entry.path);
    const before = readPath(baseline, entry.path);
    if (next === undefined || next === before) continue;
    const check = validateSettingValue(entry, next);
    if (!check.ok) continue;
    const parts = splitPath(entry.path);
    let cursor = patch;
    for (let index = 0; index < parts.length - 1; index += 1) {
      cursor[parts[index]] = cursor[parts[index]] ?? {};
      cursor = cursor[parts[index]];
    }
    cursor[parts[parts.length - 1]] = check.value;
    changed.push(entry.path);
  }
  return { patch, changed };
}

export function settingsValuesToLocalDocument(values) {
  return {
    kind: 'blur.ui.local',
    schemaVersion: UI_LOCAL_SETTINGS_VERSION,
    settings: {
      display: {
        resolutionScale: readPath(values, 'display.resolutionScale') ?? 'auto',
        vsync: readPath(values, 'display.vsync') === true
      },
      language: readPath(values, 'language') ?? 'en'
    },
    retailDerived: false
  };
}

export function settingsFromLocalDocument(document) {
  const values = {};
  for (const entry of LOCAL_SETTINGS_SCHEMA) {
    const raw = readPath(document?.settings, entry.path);
    const check = raw === undefined ? { ok: true, value: entry.default } : validateSettingValue(entry, raw);
    values[entry.path] = check.ok ? check.value : entry.default;
  }
  return values;
}

/** Binding entries = the 29 INPUT1 actions plus the two steering axis rows. */
export const STEER_BINDINGS = Object.freeze([
  Object.freeze({ id: 'steerLeft', label: 'Steer left', context: 'driving', axis: 'negative' }),
  Object.freeze({ id: 'steerRight', label: 'Steer right', context: 'driving', axis: 'positive' })
]);

export const BINDING_ACTIONS = Object.freeze([
  ...ACTIONS.map((action) => Object.freeze({
    id: action.id,
    label: action.label,
    context: action.context,
    axis: null
  })),
  ...STEER_BINDINGS
]);

export const BINDING_IDS = Object.freeze(BINDING_ACTIONS.map((action) => action.id));
export const BINDING_BY_ID = Object.freeze(
  Object.fromEntries(BINDING_ACTIONS.map((action) => [action.id, action])));

export function defaultBindings(options = {}) {
  const base = createDefaultBindings({ keyboardLayout: options.keyboardLayout ?? 1, padConfig: options.padConfig ?? 0 });
  return {
    schema: 'blur.input-bindings',
    version: 1,
    keyboardLayout: base.keyboardLayout,
    padConfig: base.padConfig,
    keyboard: {
      actions: JSON.parse(JSON.stringify(base.keyboard.actions)),
      steer: JSON.parse(JSON.stringify(base.keyboard.axes.steer))
    },
    pad: { actions: JSON.parse(JSON.stringify(base.pad.actions)) }
  };
}

export function normalizeBindings(input, options = {}) {
  const fallback = defaultBindings(options);
  if (!input || typeof input !== 'object') return fallback;
  const out = defaultBindings(options);
  if ([0, 1].includes(input.keyboardLayout)) out.keyboardLayout = input.keyboardLayout;
  if ([0, 1, 2].includes(input.padConfig)) out.padConfig = input.padConfig;
  for (const id of ACTION_IDS) {
    const keyboard = input.keyboard?.actions?.[id];
    if (Array.isArray(keyboard)) out.keyboard.actions[id] = keyboard.filter((code) => typeof code === 'string' && code);
    const pad = input.pad?.actions?.[id];
    if (Array.isArray(pad)) out.pad.actions[id] = pad.filter((code) => PAD_BUTTON_INDEX[code] !== undefined);
  }
  for (const side of ['negative', 'positive']) {
    const list = input.keyboard?.steer?.[side];
    if (Array.isArray(list)) out.keyboard.steer[side] = list.filter((code) => typeof code === 'string' && code);
  }
  return out;
}

export function bindingCodes(bindings, actionId, device) {
  const action = BINDING_BY_ID[actionId];
  if (!action) return null;
  if (device === 'keyboard' && action.axis) return bindings.keyboard.steer[action.axis];
  if (device === 'pad' && action.axis) return null;
  return device === 'keyboard'
    ? (bindings.keyboard.actions[actionId] ?? [])
    : (bindings.pad.actions[actionId] ?? []);
}

/**
 * Capture one binding. Rejects an unknown action/device/code and a conflict in
 * the same context. Returns `{ ok, bindings, conflict }` without mutating input.
 */
export function captureBinding(bindings, actionId, device, code) {
  const action = BINDING_BY_ID[actionId];
  if (!action) return { ok: false, reason: 'unknown-action', code };
  if (device !== 'keyboard' && device !== 'pad') return { ok: false, reason: 'unknown-device', code };
  if (device === 'pad' && action.axis) return { ok: false, reason: 'axis-is-keyboard-only', code };
  if (typeof code !== 'string' || !code) return { ok: false, reason: 'empty-code', code };
  if (device === 'pad' && PAD_BUTTON_INDEX[code] === undefined) {
    return { ok: false, reason: 'unknown-pad-button', code };
  }
  if (device === 'keyboard' && !/^[A-Za-z0-9]{1,32}$/.test(code)) {
    return { ok: false, reason: 'invalid-keyboard-code', code };
  }

  const copy = JSON.parse(JSON.stringify(bindings));
  const conflict = findBindingConflict(copy, actionId, device, code);
  if (conflict) return { ok: false, reason: 'conflict', code, conflict };

  if (device === 'keyboard' && action.axis) {
    copy.keyboard.steer[action.axis] = [code];
  } else if (device === 'keyboard') {
    copy.keyboard.actions[actionId] = [code];
  } else {
    copy.pad.actions[actionId] = [code];
  }
  return { ok: true, bindings: copy, conflict: null, code };
}

export function findBindingConflict(bindings, actionId, device, code) {
  const target = BINDING_BY_ID[actionId];
  if (!target) return null;
  for (const other of BINDING_ACTIONS) {
    if (other.id === actionId) continue;
    if (other.context !== target.context) continue;
    const codes = bindingCodes(bindings, other.id, device) ?? [];
    if (codes.includes(code)) {
      return { action: other.id, label: other.label, context: other.context, code, device };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Pause policy. Multiplayer is host-authoritative: no local menu may stop it.
// ---------------------------------------------------------------------------

export function pausePolicy(state) {
  if (state.context !== 'race') {
    return {
      canPause: false,
      pausesSimulation: false,
      authority: 'none',
      roomContinues: false,
      reason: 'no race is running'
    };
  }
  if (state.mode === 'solo') {
    return {
      canPause: true,
      pausesSimulation: true,
      authority: 'local',
      roomContinues: false,
      reason: 'single-player simulation is local; opening a screen pauses it'
    };
  }
  return {
    canPause: false,
    pausesSimulation: false,
    authority: 'host',
    roomContinues: true,
    reason: 'the room clock is host-authoritative; this session menu never stops the simulation'
  };
}

export function escapeIntent(state) {
  if (state.stack.length > 0) return { type: 'ui/back', owned: true };
  return { type: null, owned: false };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export function createUiState(options = {}) {
  const profileSettings = options.profileSettings ?? options.profile?.settings ?? null;
  const loaded = settingsFromProfile(profileSettings, {
    readOnly: options.readOnly === true || options.profile?.schemaVersion > 1,
    schemaVersion: options.profile?.schemaVersion ?? options.schemaVersion ?? 1
  });
  const localValues = settingsFromLocalDocument(options.local);
  const values = { ...loaded.values, ...localValues };
  const bindings = normalizeBindings(options.bindings, {
    keyboardLayout: options.keyboardLayout ?? 1,
    padConfig: options.padConfig ?? 0
  });
  const initialScreen = SCREEN_IDS.includes(options.initialScreen) ? options.initialScreen : null;
  const state = {
    schema: UI_SCHEMA,
    version: UI_SCREENS_VERSION,
    revision: 0,
    context: options.context === 'race' || options.context === 'boot' ? options.context : 'menu',
    mode: options.mode === 'host' || options.mode === 'guest' ? options.mode : 'solo',
    stack: initialScreen ? [{ id: initialScreen, params: { ...(options.params ?? {}) } }] : [],
    settings: {
      values,
      baseline: { ...values },
      dirty: false,
      resetPending: false,
      profileReadOnly: loaded.readOnly,
      issues: loaded.issues,
      revision: options.profile?.revision ?? 0
    },
    bindings,
    capture: null,
    error: null,
    connection: null,
    versionInfo: null,
    browser: null,
    confirmQuit: null,
    loading: null,
    focus: { index: 0 },
    reducedMotion: options.reducedMotion === true,
    paused: false,
    effects: [],
    lastAction: null
  };
  if (initialScreen) applyScreenData(state, initialScreen, options.params ?? {}, []);
  state.paused = derivePaused(state);
  return state;
}

function bump(state, patch, effects = []) {
  return {
    ...state,
    ...patch,
    revision: state.revision + 1,
    effects,
    lastAction: patch.lastAction ?? state.lastAction
  };
}

export function activeScreen(state) {
  return state.stack.length ? state.stack[state.stack.length - 1] : null;
}

export function isOpen(state) {
  return state.stack.length > 0;
}

function derivePaused(state) {
  const policy = pausePolicy(state);
  return policy.pausesSimulation && state.stack.length > 0;
}

function reject(state, type, reason, detail = null) {
  return bump(state, {}, [{ type, reason, detail }]);
}

function applyScreenData(state, id, params, effects) {
  if (id === 'error-details') {
    const code = params.code ?? state.error?.requestedCode ?? 'UNKNOWN_ERROR';
    state.error = {
      ...resolveError(code),
      detail: params.detail ?? state.error?.detail ?? null,
      context: params.context ?? null,
      diagnostic: buildDiagnostic(state, code, params.context ?? params.diagnosticContext ?? null)
    };
    if (params.detail !== undefined) {
      state.error.diagnostic.detail = sanitizeText(params.detail);
    }
    effects.push({ type: 'error', code: state.error.code, requestedCode: state.error.requestedCode });
  } else if (id === 'connection-lost') {
    state.connection = {
      code: params.code ?? state.connection?.code ?? 'NETWORK_LOST',
      status: params.status ?? state.connection?.status ?? 'lost',
      attempt: Number.isInteger(params.attempt) ? params.attempt : (state.connection?.attempt ?? 0),
      maxAttempts: Number.isInteger(params.maxAttempts) ? params.maxAttempts : (state.connection?.maxAttempts ?? 3),
      roomCode: params.roomCode ?? state.connection?.roomCode ?? null,
      latencyMs: Number.isFinite(params.latencyMs) ? params.latencyMs : (state.connection?.latencyMs ?? null)
    };
    effects.push({ type: 'connection', code: state.connection.code, attempt: state.connection.attempt });
  } else if (id === 'version-mismatch') {
    state.versionInfo = {
      expected: String(params.expected ?? state.versionInfo?.expected ?? 'unknown'),
      actual: String(params.actual ?? state.versionInfo?.actual ?? 'unknown'),
      kind: params.kind ?? state.versionInfo?.kind ?? 'room',
      code: params.code ?? 'VERSION_MISMATCH'
    };
    effects.push({ type: 'version-mismatch', ...state.versionInfo });
  } else if (id === 'unsupported-browser') {
    const missing = Array.isArray(params.missing)
      ? params.missing.map((entry) => String(entry)).filter(Boolean)
      : (state.browser?.missing ?? []);
    state.browser = {
      missing,
      code: params.code ?? (missing.length === 1 ? missing[0] : 'BROWSER_UNSUPPORTED'),
      userAgent: params.userAgent ?? state.browser?.userAgent ?? null,
      allowContinue: params.allowContinue === true
    };
    effects.push({ type: 'unsupported-browser', missing: [...missing] });
  } else if (id === 'confirm-quit') {
    state.confirmQuit = {
      target: params.target ?? state.confirmQuit?.target ?? 'menu',
      label: params.label ?? null,
      roomCode: params.roomCode ?? state.connection?.roomCode ?? null
    };
    effects.push({ type: 'confirm-quit', target: state.confirmQuit.target });
  } else if (id === 'loading') {
    state.loading = {
      label: params.label ?? state.loading?.label ?? 'Loading race',
      progress: Number.isFinite(params.progress) ? Math.max(0, Math.min(1, params.progress)) : (state.loading?.progress ?? null),
      attempt: Number.isInteger(params.attempt) ? params.attempt : (state.loading?.attempt ?? 1),
      canCancel: params.canCancel !== false,
      code: params.code ?? state.loading?.code ?? null
    };
    effects.push({ type: 'loading', attempt: state.loading.attempt, progress: state.loading.progress });
  }
}

export function openScreen(state, id, params = {}) {
  if (!SCREEN_IDS.includes(id)) {
    return reject(state, 'ui/rejected', 'unknown-screen', String(id));
  }
  const top = activeScreen(state);
  if (top && top.id === id) {
    return reject(state, 'ui/rejected', 'already-open', id);
  }
  if (top && id !== 'error-details' && !(OPEN_CHILDREN[top.id] ?? []).includes(id)) {
    return reject(state, 'ui/rejected', 'invalid-transition', top.id + ' -> ' + id);
  }
  if (!top && id === 'error-details' && !state.error && !params.code) {
    return reject(state, 'ui/rejected', 'missing-error-code', null);
  }

  const effects = [];
  const next = {
    ...state,
    stack: [...state.stack, { id, params: { ...params } }],
    focus: { index: 0 },
    effects: []
  };
  applyScreenData(next, id, params, effects);

  const wasPaused = state.paused;
  next.paused = derivePaused(next);
  if (!wasPaused && next.paused) {
    effects.push({ type: 'pause', paused: true, authority: 'local', reason: pausePolicy(next).reason });
  } else if (!wasPaused && !next.paused && state.context === 'race' && state.stack.length === 0) {
    effects.push({ type: 'session-menu', paused: false, roomContinues: true, reason: pausePolicy(next).reason });
  }
  effects.push({ type: 'open', screen: id, params: { ...params }, paused: next.paused });
  return bump(next, { effects }, effects);
}

export function closeScreen(state) {
  if (!state.stack.length) {
    return bump(state, {}, [{ type: 'close', screen: null, paused: false }]);
  }
  const closed = state.stack[state.stack.length - 1];
  const effects = [];
  if (closed.id === 'settings' && state.settings.dirty) {
    effects.push({ type: 'settings-unsaved', values: { ...state.settings.values } });
  }
  const top = state.stack.slice(0, -1);
  const next = {
    ...state,
    stack: top,
    capture: closed.id === 'controls' ? null : state.capture,
    confirmQuit: closed.id === 'confirm-quit' ? null : state.confirmQuit,
    effects: []
  };
  const wasPaused = state.paused;
  next.paused = derivePaused(next);
  if (wasPaused && !next.paused) {
    effects.push({ type: 'resume', paused: false, authority: 'local' });
  }
  effects.push({ type: 'close', screen: closed.id, paused: next.paused, resumed: wasPaused && !next.paused });
  return bump(next, { effects }, effects);
}

function patchSettings(state, patch) {
  return {
    ...state.settings,
    ...patch,
    dirty: !settingsEqual(patch.values ?? state.settings.values, patch.baseline ?? state.settings.baseline)
  };
}

function settingsEqual(a, b) {
  return SETTINGS_SCHEMA.every((entry) => readPath(a, entry.path) === readPath(b, entry.path));
}

function settingEffect(entry, value, extra = {}) {
  return {
    type: 'apply-setting',
    path: entry.path,
    value,
    scope: entry.scope,
    retailDerived: entry.retailDerived,
    apply: entry.apply,
    ...extra
  };
}

export function reduce(state, action = {}) {
  switch (action.type) {
    case 'ui/open':
      return openScreen(state, action.screen ?? action.id, action.params ?? {});

    case 'ui/back':
    case 'ui/close':
      return closeScreen(state);

    case 'ui/close-all': {
      const effects = [{ type: 'close-all', screens: state.stack.map((entry) => entry.id) }];
      if (state.paused) effects.push({ type: 'resume', paused: false, authority: 'local' });
      return bump(state, {
        stack: [], paused: false, capture: null, confirmQuit: null, effects: []
      }, effects);
    }

    case 'ui/escape': {
      if (!state.stack.length) return bump(state, {}, [{ type: 'escape-unhandled', owned: false }]);
      return closeScreen(state);
    }

    case 'ui/set-context': {
      if (action.context !== 'menu' && action.context !== 'race' && action.context !== 'boot') {
        return reject(state, 'ui/rejected', 'unknown-context', String(action.context));
      }
      if (action.mode !== undefined && !['solo', 'host', 'guest'].includes(action.mode)) {
        return reject(state, 'ui/rejected', 'unknown-mode', String(action.mode));
      }
      const next = {
        ...state,
        context: action.context,
        mode: action.mode ?? state.mode
      };
      next.paused = derivePaused(next);
      return bump(next, { paused: next.paused }, [{
        type: 'context',
        context: next.context,
        mode: next.mode,
        pausesSimulation: pausePolicy(next).pausesSimulation
      }]);
    }

    case 'ui/focus': {
      const index = Number(action.index);
      if (!Number.isInteger(index) || index < 0) {
        return reject(state, 'ui/rejected', 'invalid-focus-index', String(action.index));
      }
      return bump(state, { focus: { index } }, []);
    }

    case 'settings/load': {
      const loaded = settingsFromProfile(action.profileSettings, {
        readOnly: action.readOnly === true || action.schemaVersion > 1,
        schemaVersion: action.schemaVersion ?? 1
      });
      const local = action.local ? settingsFromLocalDocument(action.local) : {};
      const values = { ...loaded.values, ...local };
      const settings = {
        ...state.settings,
        values,
        baseline: { ...values },
        dirty: false,
        resetPending: false,
        profileReadOnly: loaded.readOnly,
        issues: loaded.issues,
        revision: action.revision ?? state.settings.revision
      };
      const effects = loaded.readOnly
        ? [{ type: 'settings-read-only', reason: 'future-schema-or-unrecovered' }]
        : [];
      return bump(state, { settings }, effects);
    }

    case 'settings/set': {
      const entry = SETTINGS_BY_PATH[action.path];
      if (!entry) {
        return bump(state, {}, [{ type: 'settings-rejected', path: action.path, reason: 'unknown-field' }]);
      }
      const check = validateSettingValue(entry, action.value);
      if (!check.ok) {
        return bump(state, {}, [{
          type: 'settings-rejected',
          path: entry.path,
          reason: check.reason,
          allowed: check.allowed ?? null,
          min: check.min ?? null,
          max: check.max ?? null
        }]);
      }
      const current = readPath(state.settings.values, entry.path);
      if (current === check.value && !action.force) {
        return state;
      }
      const values = writePath(state.settings.values, entry.path, check.value);
      const settings = patchSettings(state, { values });
      return bump(state, { settings }, [
        settingEffect(entry, check.value, { commit: action.commit === true })
      ]);
    }

    case 'settings/commit': {
      const { patch, changed } = settingsValuesToProfilePatch(
        state.settings.values, state.settings.baseline);
      const local = settingsValuesToLocalDocument(state.settings.values);
      const effects = [];
      if (state.settings.profileReadOnly) {
        effects.push({ type: 'settings-commit-blocked', reason: 'profile-read-only' });
      } else {
        effects.push({
          type: 'settings-commit',
          profilePatch: patch,
          changed,
          local,
          localKey: UI_LOCAL_SETTINGS_KEY,
          readOnly: false
        });
      }
      return bump(state, { settings: { ...state.settings, resetPending: false } }, effects);
    }

    case 'settings/saved': {
      const settings = {
        ...state.settings,
        baseline: { ...state.settings.values },
        dirty: false,
        resetPending: false,
        revision: action.revision ?? state.settings.revision
      };
      return bump(state, { settings }, [{ type: 'settings-saved', revision: settings.revision }]);
    }

    case 'settings/revert': {
      const applied = [];
      for (const entry of SETTINGS_SCHEMA) {
        const before = readPath(state.settings.values, entry.path);
        const after = readPath(state.settings.baseline, entry.path);
        if (before !== after) applied.push({ path: entry.path, value: after, scope: entry.scope });
      }
      const settings = {
        ...state.settings,
        values: { ...state.settings.baseline },
        dirty: false,
        resetPending: false
      };
      return bump(state, { settings }, [
        { type: 'settings-revert', applied },
        ...applied.map((change) => ({
          type: 'apply-setting',
          path: change.path,
          value: change.value,
          scope: change.scope,
          revert: true
        }))
      ]);
    }

    case 'settings/reset-request': {
      return bump(state, {
        settings: { ...state.settings, resetPending: true }
      }, [{ type: 'settings-reset-request', scope: action.scope ?? 'all' }]);
    }

    case 'settings/reset-cancel':
      if (!state.settings.resetPending) return state;
      return bump(state, { settings: { ...state.settings, resetPending: false } }, []);

    case 'settings/reset-confirm': {
      const values = defaultSettings();
      const settings = {
        ...state.settings,
        values,
        resetPending: false,
        dirty: !settingsEqual(values, state.settings.baseline)
      };
      return bump(state, { settings }, [
        { type: 'settings-reset', values: { ...values }, retailDerived: false },
        ...SETTINGS_SCHEMA.map((entry) => settingEffect(entry, readPath(values, entry.path), { reset: true }))
      ]);
    }

    case 'error/show': {
      const code = action.code ?? 'UNKNOWN_ERROR';
      const next = { ...state, effects: [] };
      next.error = {
        ...resolveError(code),
        detail: action.detail ?? null,
        context: action.context ?? null,
        diagnostic: buildDiagnostic(next, code, action.context ?? null)
      };
      if (action.detail !== undefined) next.error.diagnostic.detail = sanitizeText(action.detail);
      return bump(next, {}, [{
        type: 'error',
        code: next.error.code,
        requestedCode: next.error.requestedCode,
        diagnostic: next.error.diagnostic
      }]);
    }

    case 'error/close':
      if (!state.error) return state;
      return bump(state, { error: null }, [{ type: 'error-close' }]);

    case 'error/retry':
      return bump(state, {}, [{
        type: 'error-retry',
        code: action.code ?? state.error?.code ?? 'UNKNOWN_ERROR',
        screen: activeScreen(state)?.id ?? null
      }]);

    case 'connection/lost':
      return openScreen(state, 'connection-lost', {
        code: action.code ?? 'NETWORK_LOST',
        status: action.status ?? 'lost',
        attempt: action.attempt ?? 0,
        maxAttempts: action.maxAttempts,
        roomCode: action.roomCode,
        latencyMs: action.latencyMs
      });

    case 'connection/retry': {
      if (!state.connection) return reject(state, 'connection-rejected', 'no-connection-state');
      const attempt = state.connection.attempt + 1;
      const connection = { ...state.connection, attempt, status: 'reconnecting' };
      return bump(state, { connection }, [{
        type: 'connection-retry',
        code: connection.code,
        attempt,
        maxAttempts: connection.maxAttempts,
        roomCode: connection.roomCode
      }]);
    }

    case 'connection/cancel': {
      if (!state.connection) return state;
      const code = state.connection.code;
      const effects = [{ type: 'connection-cancel', code }];
      const next = { ...state, connection: null };
      const closed = closeScreen(next);
      return bump(closed, {}, [...effects, ...closed.effects]);
    }

    case 'version/show':
      return openScreen(state, 'version-mismatch', {
        expected: action.expected,
        actual: action.actual,
        kind: action.kind,
        code: action.code
      });

    case 'browser/show':
      return openScreen(state, 'unsupported-browser', {
        missing: action.missing,
        code: action.code,
        userAgent: action.userAgent,
        allowContinue: action.allowContinue
      });

    case 'browser/details': {
      const missing = state.browser?.missing ?? [];
      const code = state.browser?.code ?? 'BROWSER_UNSUPPORTED';
      return openScreen(state, 'error-details', {
        code,
        detail: missing.length ? 'Missing: ' + missing.join(', ') : null,
        context: { missing }
      });
    }

    case 'quit/request':
      return openScreen(state, 'confirm-quit', {
        target: action.target ?? 'menu',
        label: action.label,
        roomCode: action.roomCode ?? state.connection?.roomCode
      });

    case 'quit/confirm': {
      const target = state.confirmQuit?.target ?? action.target ?? 'menu';
      const wasPaused = state.paused;
      const effects = [{ type: 'quit', target, paused: wasPaused, roomContinues: pausePolicy(state).roomContinues }];
      if (wasPaused) effects.push({ type: 'resume', paused: false, authority: 'local' });
      return bump(state, {
        stack: [], paused: false, confirmQuit: null, capture: null, effects: []
      }, effects);
    }

    case 'quit/cancel':
      return closeScreen(state);

    case 'binding/load': {
      const bindings = normalizeBindings(action.bindings, {
        keyboardLayout: state.bindings.keyboardLayout,
        padConfig: state.bindings.padConfig
      });
      return bump(state, { bindings }, [{ type: 'bindings-loaded' }]);
    }

    case 'binding/capture-start': {
      const actionDef = BINDING_BY_ID[action.action];
      if (!actionDef) return reject(state, 'binding-rejected', 'unknown-action', String(action.action));
      const device = action.device === 'pad' ? 'pad' : 'keyboard';
      if (device === 'pad' && actionDef.axis) {
        return reject(state, 'binding-rejected', 'axis-is-keyboard-only', action.action);
      }
      return bump(state, {
        capture: {
          action: action.action,
          device,
          waiting: true,
          code: null,
          conflict: null
        }
      }, [{ type: 'binding-capture-start', action: action.action, device }]);
    }

    case 'binding/capture-key': {
      if (!state.capture || state.capture.device !== 'keyboard') {
        return reject(state, 'binding-rejected', 'no-keyboard-capture');
      }
      if (action.code === 'Escape') {
        return bump(state, { capture: null }, [{ type: 'binding-capture-cancel', action: state.capture.action }]);
      }
      const result = captureBinding(state.bindings, state.capture.action, 'keyboard', action.code);
      if (!result.ok) {
        const capture = { ...state.capture, code: action.code, conflict: result.conflict ?? null };
        const reason = result.reason;
        return bump(state, { capture }, [
          { type: 'binding-rejected', action: state.capture.action, device: 'keyboard', code: action.code, reason, conflict: result.conflict ?? null }
        ]);
      }
      return bump(state, { bindings: result.bindings, capture: null }, [{
        type: 'binding-captured',
        action: state.capture.action,
        device: 'keyboard',
        code: action.code,
        bindings: result.bindings
      }]);
    }

    case 'binding/capture-pad': {
      if (!state.capture || state.capture.device !== 'pad') {
        return reject(state, 'binding-rejected', 'no-pad-capture');
      }
      const result = captureBinding(state.bindings, state.capture.action, 'pad', action.button);
      if (!result.ok) {
        const capture = { ...state.capture, code: action.button, conflict: result.conflict ?? null };
        return bump(state, { capture }, [
          { type: 'binding-rejected', action: state.capture.action, device: 'pad', code: action.button, reason: result.reason, conflict: result.conflict ?? null }
        ]);
      }
      return bump(state, { bindings: result.bindings, capture: null }, [{
        type: 'binding-captured',
        action: state.capture.action,
        device: 'pad',
        code: action.button,
        bindings: result.bindings
      }]);
    }

    case 'binding/capture-cancel': {
      if (!state.capture) return state;
      return bump(state, { capture: null }, [{
        type: 'binding-capture-cancel',
        action: state.capture.action
      }]);
    }

    case 'binding/reset': {
      const bindings = defaultBindings({
        keyboardLayout: state.bindings.keyboardLayout,
        padConfig: state.bindings.padConfig
      });
      return bump(state, { bindings }, [{ type: 'bindings-reset' }]);
    }

    case 'loading/update': {
      if (!state.loading) return reject(state, 'ui/rejected', 'no-loading-state');
      const loading = {
        ...state.loading,
        progress: Number.isFinite(action.progress)
          ? Math.max(0, Math.min(1, action.progress))
          : state.loading.progress,
        label: action.label ?? state.loading.label
      };
      return bump(state, { loading }, [{ type: 'loading', progress: loading.progress, label: loading.label }]);
    }

    case 'loading/cancel': {
      const effects = [{ type: 'loading-cancel' }];
      if (activeScreen(state)?.id === 'loading') {
        const closed = closeScreen(state);
        return bump(closed, {}, [...effects, ...closed.effects]);
      }
      return bump(state, { loading: null }, effects);
    }

    default:
      return reject(state, 'ui/rejected', 'unknown-action', String(action.type));
  }
}

// ---------------------------------------------------------------------------
// Navigation (keyboard + gamepad)
// ---------------------------------------------------------------------------

export function nextFocusIndex(index, count, key, columns = 1) {
  if (!Number.isInteger(index) || count <= 0) return 0;
  const columnCount = Math.max(1, Number(columns) || 1);
  if (key === 'ArrowLeft' || key === 'left') return Math.max(0, index - 1);
  if (key === 'ArrowRight' || key === 'right') return Math.min(count - 1, index + 1);
  if (key === 'ArrowUp' || key === 'up') return index - columnCount >= 0 ? index - columnCount : index;
  if (key === 'ArrowDown' || key === 'down') {
    const next = index + columnCount;
    return next < count ? next : index;
  }
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return index;
}

export function trapFocusIndex(index, count, shift) {
  if (count <= 0) return 0;
  if (index < 0 || index >= count) return shift ? count - 1 : 0;
  if (shift) return index === 0 ? count - 1 : index - 1;
  return index === count - 1 ? 0 : index + 1;
}

const PAD = PAD_BUTTON_INDEX;
const AXIS_THRESHOLD = 0.5;

/** Edge-triggered standard-mapping gamepad intent. */
export function gamepadIntent(buttons = [], axes = [], previous = { buttons: [], axes: [] }) {
  const down = (index) => buttons[index] === true || buttons[index]?.pressed === true;
  const was = (index) => previous.buttons?.[index] === true || previous.buttons?.[index]?.pressed === true;
  if (down(PAD.Start) && !was(PAD.Start)) return 'pause';
  if (down(PAD.Back) && !was(PAD.Back)) return 'back';
  if (down(PAD.B) && !was(PAD.B)) return 'back';
  if (down(PAD.A) && !was(PAD.A)) return 'confirm';
  if (down(PAD.DPadUp) && !was(PAD.DPadUp)) return 'up';
  if (down(PAD.DPadDown) && !was(PAD.DPadDown)) return 'down';
  if (down(PAD.DPadLeft) && !was(PAD.DPadLeft)) return 'left';
  if (down(PAD.DPadRight) && !was(PAD.DPadRight)) return 'right';
  const x = Number(axes[0] ?? 0);
  const y = Number(axes[1] ?? 0);
  const previousX = Number(previous.axes?.[0] ?? 0);
  const previousY = Number(previous.axes?.[1] ?? 0);
  if (y < -AXIS_THRESHOLD && previousY >= -AXIS_THRESHOLD) return 'up';
  if (y > AXIS_THRESHOLD && previousY <= AXIS_THRESHOLD) return 'down';
  if (x < -AXIS_THRESHOLD && previousX >= -AXIS_THRESHOLD) return 'left';
  if (x > AXIS_THRESHOLD && previousX <= AXIS_THRESHOLD) return 'right';
  return null;
}

/** Focus movement for a flat list of focusable elements. Returns -1 for none. */
export function navigateFocus(index, count, intent, columns = 1) {
  if (!['up', 'down', 'left', 'right', 'home', 'end'].includes(intent)) return index;
  if (count <= 0) return -1;
  const current = index < 0 || index >= count ? 0 : index;
  if (intent === 'home') return 0;
  if (intent === 'end') return count - 1;
  return nextFocusIndex(current, count, intent, columns);
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

const SECRET_KEY = /(token|secret|password|passwd|auth|cookie|credential|api[-_]?key|session[-_]?id|email|display[-_]?name|player[-_]?name)/i;
const WINDOWS_PATH = /[A-Za-z]:\\[^\s"'<>]+/g;
const POSIX_HOME = /\/(?:home|Users)\/[^\s"'<>]+/g;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const QUERY_SECRET = /([?&](?:token|key|secret|auth|code|password)=)[^&#\s]+/gi;

export function sanitizeText(value, maxLength = 400) {
  if (value === null || value === undefined) return null;
  let text = String(value);
  text = text.replace(WINDOWS_PATH, '<path>');
  text = text.replace(POSIX_HOME, '<path>');
  text = text.replace(BEARER, '$1 <redacted>');
  text = text.replace(QUERY_SECRET, '$1<redacted>');
  return text.length > maxLength ? text.slice(0, maxLength) + '…' : text;
}

export function redactDiagnostics(value, depth = 0) {
  if (depth > 4) return '<depth-limit>';
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return sanitizeText(value);
  if (Array.isArray(value)) return value.map((entry) => redactDiagnostics(entry, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (SECRET_KEY.test(key)) {
        out[key] = '<redacted>';
        continue;
      }
      out[key] = redactDiagnostics(value[key], depth + 1);
    }
    return out;
  }
  return null;
}

export function buildDiagnostic(state, code, context = null) {
  const error = resolveError(code);
  const policy = pausePolicy(state);
  const diagnostic = {
    schema: 'blur.ui-diagnostic',
    version: 1,
    generator: 'ui-screens/' + UI_SCREENS_VERSION,
    code: error.code,
    requestedCode: error.requestedCode,
    title: error.title,
    severity: error.severity,
    explanation: error.explanation,
    screen: activeScreen(state)?.id ?? 'closed',
    context: state.context,
    mode: state.mode,
    paused: state.paused,
    pauseAuthority: policy.authority,
    roomContinues: policy.roomContinues,
    detail: null,
    missing: state.browser?.missing ?? [],
    roomCode: state.connection?.roomCode ?? state.confirmQuit?.roomCode ?? null,
    settings: {
      quality: readPath(state.settings.values, 'quality'),
      resolutionScale: readPath(state.settings.values, 'display.resolutionScale'),
      language: readPath(state.settings.values, 'language'),
      profileReadOnly: state.settings.profileReadOnly
    },
    contextData: context === null ? null : redactDiagnostics(context),
    notes: [
      PROJECT_LAYOUT_NOTE,
      'The diagnostic block contains no tokens, cookies, credentials, player names or local file paths.'
    ]
  };
  return diagnostic;
}

/** Deterministic, sorted-key JSON for hashing and for the copy button. */
export function canonicalJson(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  }
  return 'null';
}

export function diagnosticText(diagnostic) {
  return JSON.stringify(JSON.parse(canonicalJson(diagnostic)), null, 2);
}

export function fnv1a32(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return 'fnv1a32:' + hash.toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// Browser capability classification (compat/requirements.json)
// ---------------------------------------------------------------------------

export const BROWSER_REQUIREMENTS = Object.freeze([
  Object.freeze({ id: 'BROWSER_NO_WEBGPU', label: 'navigator.gpu / WebGPU adapter' }),
  Object.freeze({ id: 'BROWSER_NO_SECURE_CONTEXT', label: 'secure context (https or localhost)' }),
  Object.freeze({ id: 'BROWSER_NO_CRYPTO_SUBTLE', label: 'crypto.subtle SHA-256' }),
  Object.freeze({ id: 'BROWSER_NO_WASM', label: 'WebAssembly' }),
  Object.freeze({ id: 'MODULE_UNSUPPORTED', label: 'ES modules with top-level await' })
]);

export function classifyBrowser(capabilities = {}) {
  const missing = [];
  if (capabilities.webgpu === false) missing.push('BROWSER_NO_WEBGPU');
  if (capabilities.secureContext === false) missing.push('BROWSER_NO_SECURE_CONTEXT');
  if (capabilities.cryptoSubtle === false) missing.push('BROWSER_NO_CRYPTO_SUBTLE');
  if (capabilities.wasm === false) missing.push('BROWSER_NO_WASM');
  if (capabilities.modules === false) missing.push('MODULE_UNSUPPORTED');
  if (Array.isArray(capabilities.missingWasmFeatures) && capabilities.missingWasmFeatures.length) {
    missing.push('WASM_FEATURE_MISSING');
  }
  if (Number.isFinite(capabilities.memoryBytes) && capabilities.memoryBytes < 256 * 1024 * 1024) {
    missing.push('WASM_MEMORY_LIMIT');
  }
  return {
    ok: missing.length === 0,
    missing,
    code: missing.length === 1 ? missing[0] : 'BROWSER_UNSUPPORTED',
    labels: missing.map((code) => {
      const entry = ERROR_CATALOG[code];
      return { code, title: entry?.title ?? code, requirement: BROWSER_REQUIREMENTS.find((item) => item.id === code)?.label ?? null };
    })
  };
}

// ---------------------------------------------------------------------------
// Deterministic snapshot states for visual checking
// ---------------------------------------------------------------------------

function fixedErrorStatus() {
  return {
    detail: 'fetch /probes/e1-drive/geometry/amboy.json failed with HTTP 404',
    context: { httpStatus: 404, asset: 'amboy.json' }
  };
}

export const SNAPSHOT_NAMES = Object.freeze([
  'pause-solo',
  'pause-multiplayer',
  'settings',
  'controls',
  'loading',
  'connection-lost',
  'version-mismatch',
  'unsupported-browser',
  'confirm-quit',
  'error-details'
]);

export function snapshotStates() {
  const base = () => createUiState({
    context: 'race',
    mode: 'solo',
    profileSettings: {
      quality: 'high',
      volumes: { master: 0.8, music: 0.4, sfx: 0.7 },
      muted: false,
      cameraMode: 'orbit',
      steer: 'normal',
      inputBindingsRef: 'default-keyboard-v1',
      hud: { showSpeed: true, showGhostDelta: false, showMinimap: true, units: 'imperial' }
    },
    profile: { schemaVersion: 1, revision: 7 },
    reducedMotion: true
  });
  const states = [];

  let state = reduce(base(), { type: 'ui/open', screen: 'pause' });
  states.push({ name: 'pause-solo', state: strip(state) });

  state = base();
  state = { ...state, mode: 'guest', context: 'race' };
  state = reduce(state, { type: 'ui/open', screen: 'pause', params: { roomCode: 'K7M2Q' } });
  states.push({ name: 'pause-multiplayer', state: strip(state) });

  state = base();
  state = reduce(state, { type: 'ui/open', screen: 'pause' });
  state = reduce(state, { type: 'ui/open', screen: 'settings' });
  states.push({ name: 'settings', state: strip(state) });

  state = base();
  state = reduce(state, { type: 'ui/open', screen: 'pause' });
  state = reduce(state, { type: 'ui/open', screen: 'controls' });
  state = reduce(state, { type: 'binding/capture-start', action: 'throttle', device: 'keyboard' });
  states.push({ name: 'controls', state: strip(state) });

  state = { ...createUiState({ context: 'menu' }) };
  state = reduce(state, { type: 'ui/open', screen: 'loading', params: { label: 'Verifying map pins', progress: 0.42, attempt: 1 } });
  states.push({ name: 'loading', state: strip(state) });

  state = base();
  state = { ...state, mode: 'host' };
  state = reduce(state, { type: 'connection/lost', code: 'NETWORK_LOST', attempt: 1, roomCode: 'K7M2Q', latencyMs: 84 });
  states.push({ name: 'connection-lost', state: strip(state) });

  state = createUiState({ context: 'menu' });
  state = reduce(state, { type: 'version/show', expected: '2', actual: '1', kind: 'room' });
  states.push({ name: 'version-mismatch', state: strip(state) });

  state = createUiState({ context: 'boot' });
  state = reduce(state, {
    type: 'browser/show',
    missing: ['BROWSER_NO_WEBGPU', 'BROWSER_NO_CRYPTO_SUBTLE'],
    userAgent: 'Example/1.0'
  });
  states.push({ name: 'unsupported-browser', state: strip(state) });

  state = base();
  state = reduce(state, { type: 'ui/open', screen: 'pause' });
  state = reduce(state, { type: 'quit/request', target: 'menu' });
  states.push({ name: 'confirm-quit', state: strip(state) });

  state = base();
  const fixed = fixedErrorStatus();
  state = reduce(state, { type: 'ui/open', screen: 'error-details', params: { code: 'ASSET_LOAD_FAILED', detail: fixed.detail, context: fixed.context } });
  states.push({ name: 'error-details', state: strip(state) });

  return states;
}

function strip(state) {
  const copy = {
    ...state,
    effects: [],
    stack: state.stack.map((entry) => ({ id: entry.id, params: { ...entry.params } })),
    settings: {
      ...state.settings,
      values: { ...state.settings.values },
      baseline: { ...state.settings.baseline }
    }
  };
  return copy;
}

export function snapshotReport() {
  const states = snapshotStates();
  const payload = { schema: 'blur.ui-screens.snapshots', version: 1, states };
  return {
    ...payload,
    hash: fnv1a32(canonicalJson(payload))
  };
}

export const UI_SCREENS = Object.freeze({
  UI_SCREENS_VERSION,
  SCREEN_IDS,
  SCREEN_DEFS,
  ERROR_CATALOG,
  SETTINGS_SCHEMA,
  BINDING_ACTIONS,
  createUiState,
  reduce,
  openScreen,
  closeScreen,
  pausePolicy,
  classifyBrowser,
  buildDiagnostic
});
