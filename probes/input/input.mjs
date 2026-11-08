// Standalone input layer for the Blur Web ports.
//
// Scope: retail-derived keyboard + gamepad bindings, device normalisation
// (radial deadzone), per-action mapping, deterministic state export, rebinding
// and persistence. It is engine-agnostic: the e1 drive slice consumes
// `state.engineInput` = [throttle, brake, steer, handbrake], exactly the
// `e1_set_input` order.
//
// Provenance (all read-only inputs):
//   upstream/.../Game/GameControls/GameControls.cpp:110-184  keyboard layouts + pad axes
//   upstream/.../input/Pad360.cpp:15                         default stick deadzone 0.25
//   upstream/.../input/Input.cpp:10-32                       circular deadzone + rescale
//   gamedata.pak \gamedata\xt\ui.bin                          pad ControlConfigs (UiXtConfig r95)
//   upstream/.../RaceLogicCore/Core/RaceLogicCore.cpp:861-896 throttle/steer/brake/handbrake read
//   upstream/.../physics/racingphysics/.../Car/car.cpp:799-828  smoothing + signed-square steer
//   upstream/.../Game/AmaxCam/VehicleFeed.cpp:184-217,239-254   camera cycle / rear view / look axes
//
// No unknown value is guessed. What retail does not define (steering/braking
// assist) is reported as absent, not as zero. Browser gamepads are read through
// the W3C "standard" mapping only; a non-standard mapping is reported and
// ignored instead of being reinterpreted by index.

export const INPUT_SCHEMA = 'blur.input-state';
export const INPUT_VERSION = 1;
export const BINDINGS_SCHEMA = 'blur.input-bindings';
export const BINDINGS_VERSION = 1;

// C_GameInput::m_ButtonPressedThreshold (GameInput.cpp:178) is 0.1; the
// handbrake has its own explicit 0.5 threshold (RaceLogicCore.cpp:895).
export const ACTION_PRESS_THRESHOLD = 0.1;
export const HANDBRAKE_THRESHOLD = 0.5;

// C_Pad360::C_Pad360 -> m_StickDeadzone(0.25f) (Pad360.cpp:15). No caller of
// SetStickDeadzone exists in the recovered game source, so 0.25 is fixed.
export const DEFAULT_DEADZONE = 0.25;

// Retail steering shaping lives in the car physics, not in the input code:
//   steerTarget = Controls().steer * |Controls().steer|   (car.cpp:818)
//   m_dd.steer  = m_dd.steer * f + steerTarget * (1 - f)  (car.cpp:819-821)
// The e1 wasm already runs this, so `engineInput` carries the unshaped value.
export const RETAIL_CURVE = Object.freeze({
  steer: 'signed-square',
  throttle: 'linear',
  brake: 'linear',
  handbrake: 'threshold-0.5'
});

// Per-car smoothing defaults = the Corvette ZR1 stock record (record 37), the
// e1 roster default. Other cars differ; the table is in
// docs/work/analysis/input.md and _work/input/retail-input.json.
export const DEFAULT_CAR_INPUT_PARAMS = Object.freeze({
  steerSmoothTime: 0.14,
  throttleSmoothTime: 0.01,
  brakeSmoothTime: 0.1,
  handbrakeSmoothTime: 0
});

const ACTION_DEFS = [
  ['throttle', 32, 'Throttle', 'driving'],
  ['brake', 33, 'Brake', 'driving'],
  ['handbrake', 34, 'Handbrake', 'driving'],
  ['gearUp', 35, 'GearUp', 'driving'],
  ['gearDown', 36, 'GearDown', 'driving'],
  ['changeView', 37, 'ChangeView', 'driving'],
  ['resetVehicle', 38, 'ResetVehicle', 'driving'],
  ['usePickup', 39, 'UsePickup', 'driving'],
  ['discardPickup', 40, 'DiscardPickup', 'driving'],
  ['switchPickup', 41, 'SwitchPickup', 'driving'],
  ['switchPickupLeft', 42, 'SwitchPickupLeft', 'driving'],
  ['switchPickupAlt', 43, 'SwitchPickupAlt', 'driving'],
  ['useShield', 44, 'UseShield', 'driving'],
  ['useSecondTierPickup', 45, 'UseSecondTierPickup', 'driving'],
  ['autoShufflePerks', 46, 'Auto_Shuffle_Perks', 'perk'],
  ['convertToHealth', 47, 'Convert_To_Health', 'perk'],
  ['cloneSelectedPerk', 48, 'Clone_Selected_Perk', 'perk'],
  ['fullhouse', 49, 'Fullhouse', 'perk'],
  ['usePickupAlt', 50, 'UsePickupAlt', 'driving'],
  ['photoRoll', 51, 'PhotoRoll', 'photo'],
  ['photoZoom', 52, 'PhotoZoom', 'photo'],
  ['photoRollReset', 53, 'PhotoRollReset', 'photo'],
  ['photoZoomReset', 54, 'PhotoZoomReset', 'photo'],
  ['fireSlot1', 55, 'FireSlot1', 'driving'],
  ['fireSlot2', 56, 'FireSlot2', 'driving'],
  ['fireSlot3', 57, 'FireSlot3', 'driving'],
  ['rearView', 58, 'RearView', 'driving'],
  ['usePickupForward', 59, 'UsePickupForward', 'driving'],
  ['usePickupBackward', 60, 'UsePickupBackward', 'driving']
];

export const ACTIONS = Object.freeze(ACTION_DEFS.map(([id, retailIndex, label, context]) =>
  Object.freeze({ id, retailIndex, label, context })));
export const ACTION_IDS = Object.freeze(ACTIONS.map((action) => action.id));
export const ACTION_CONTEXT = Object.freeze(Object.fromEntries(
  ACTIONS.map((action) => [action.id, action.context])));
export const ACTION_BY_ID = Object.freeze(Object.fromEntries(
  ACTIONS.map((action) => [action.id, action])));

const RETAIL_BUTTON_BASE = 32;
const RETAIL_BUTTON_END = 60;

/** Validated at import: the 29 game buttons are retail indices 32..60. */
if (ACTIONS.length !== 29 ||
    ACTIONS[0].retailIndex !== RETAIL_BUTTON_BASE ||
    ACTIONS[ACTIONS.length - 1].retailIndex !== RETAIL_BUTTON_END) {
  throw new Error('retail action table must cover game buttons 32..60');
}

// ---------------------------------------------------------------------------
// Keyboard: retail layout tables (GameControls.cpp:110-184) mapped to the
// browser's physical `KeyboardEvent.code`. Layout 0 and layout 1 share the
// same table; each layout picks its column.
// ---------------------------------------------------------------------------

const LAYOUT_0_ACTIONS = Object.freeze({
  throttle: ['KeyQ'],
  brake: ['KeyA'],
  handbrake: ['ArrowDown'],
  changeView: ['KeyV'],
  usePickup: ['ControlRight'],
  usePickupForward: ['KeyW'],
  usePickupBackward: ['KeyS'],
  discardPickup: ['KeyD'],
  switchPickup: ['ArrowUp'],
  photoRoll: ['End'],
  photoZoom: ['NumpadAdd'],
  photoRollReset: ['KeyR'],
  photoZoomReset: ['KeyQ'],
  rearView: ['Tab']
});

const LAYOUT_1_ACTIONS = Object.freeze({
  throttle: ['KeyW'],
  brake: ['KeyS'],
  handbrake: ['Space'],
  changeView: ['KeyZ'],
  usePickup: ['ControlRight'],
  usePickupForward: ['ArrowUp'],
  usePickupBackward: ['ArrowDown'],
  discardPickup: ['ArrowRight'],
  switchPickup: ['ArrowLeft'],
  photoRoll: ['End'],
  photoZoom: ['NumpadAdd'],
  photoRollReset: ['KeyR'],
  photoZoomReset: ['KeyQ'],
  rearView: ['PageDown']
});

const LAYOUT_0_STEER = Object.freeze({ negative: ['ArrowLeft'], positive: ['ArrowRight'] });
const LAYOUT_1_STEER = Object.freeze({ negative: ['KeyA'], positive: ['KeyD'] });

export const KEYBOARD_LAYOUTS = Object.freeze([
  Object.freeze({
    id: 0,
    name: 'retail keyboard layout 0: Q/A + arrow steering',
    actions: emptyThen(LAYOUT_0_ACTIONS),
    axes: Object.freeze({ steer: LAYOUT_0_STEER, pitch: EMPTY_AXIS() })
  }),
  Object.freeze({
    id: 1,
    name: 'retail keyboard layout 1: W/S + A/D steering',
    actions: emptyThen(LAYOUT_1_ACTIONS),
    axes: Object.freeze({ steer: LAYOUT_1_STEER, pitch: EMPTY_AXIS() })
  })
]);

// ---------------------------------------------------------------------------
// Gamepad: retail XInput button names and the W3C standard-mapping indices.
// ---------------------------------------------------------------------------

export const PAD_BUTTON_INDEX = Object.freeze({
  A: 0, B: 1, X: 2, Y: 3,
  LeftShoulder: 4, RightShoulder: 5,
  LeftTrigger: 6, RightTrigger: 7,
  Back: 8, Start: 9,
  LeftThumb: 10, RightThumb: 11,
  DPadUp: 12, DPadDown: 13, DPadLeft: 14, DPadRight: 15
});
export const PAD_BUTTON_NAMES = Object.freeze(Object.keys(PAD_BUTTON_INDEX));

export const PAD_AXIS_INDEX = Object.freeze({
  LeftStickX: 0, LeftStickY: 1, RightStickX: 2, RightStickY: 3
});
export const PAD_AXIS_NAMES = Object.freeze(Object.keys(PAD_AXIS_INDEX));

// W3C standard mapping: +X right, +Y down. XInput: +X right, +Y up
// (Pad360.cpp:76-79 passes sThumbLY straight through). Negate Y to keep the
// retail sense.
export const PAD_AXIS_SIGN = Object.freeze({
  LeftStickX: 1, LeftStickY: -1, RightStickX: 1, RightStickY: -1
});

// C_ControlConfig records decoded from UiXtConfig (ui.bin record 95,
// ControlConfigs field offset 552, type 48, 3 x 44 B). FunctionA/B/X/Y map to
// the pad's face buttons, FunctionLT/RT/LB/RB to the triggers/shoulders.
export const PAD_CONFIGS = Object.freeze([
  Object.freeze({
    id: 0,
    locId: '0xb0b65c46',
    name: 'CMN_CONTROLLER_CONFIG_1',
    source: 'UiXtConfig record 95 ControlConfigs[0]',
    actions: emptyThen({
      throttle: ['RightTrigger'],
      brake: ['LeftTrigger'],
      handbrake: ['B'],
      usePickup: ['A'],
      switchPickup: ['X'],
      discardPickup: ['Y'],
      switchPickupAlt: ['LeftShoulder'],
      changeView: ['RightShoulder']
    })
  }),
  Object.freeze({
    id: 1,
    locId: '0x77d25e4f',
    name: 'CMN_CONTROLLER_CONFIG_2',
    source: 'UiXtConfig record 95 ControlConfigs[1]',
    actions: emptyThen({
      throttle: ['RightTrigger'],
      brake: ['LeftTrigger'],
      handbrake: ['Y'],
      usePickup: ['A'],
      switchPickupLeft: ['X'],
      switchPickupAlt: ['B'],
      discardPickup: ['LeftShoulder'],
      changeView: ['RightShoulder']
    })
  }),
  Object.freeze({
    id: 2,
    locId: '0x4956e65b',
    name: 'CMN_CONTROLLER_CONFIG_3',
    source: 'UiXtConfig record 95 ControlConfigs[2]',
    actions: emptyThen({
      throttle: ['A'],
      brake: ['B'],
      handbrake: ['RightTrigger'],
      usePickup: ['X'],
      discardPickup: ['Y'],
      switchPickup: ['LeftShoulder'],
      changeView: ['RightShoulder']
    })
  })
]);

// Pad stick roles are hardwired, not part of C_ControlConfig
// (GameControls.cpp:166-174 steering/pitch; VehicleFeed.cpp:252-253 look).
export const PAD_AXIS_ROLES = Object.freeze({
  steer: 'LeftStickX',
  pitch: 'LeftStickY',
  lookX: 'RightStickX',
  lookY: 'RightStickY'
});

// Digital steering on the D-pad is summed into the steering axis
// (GameControls.cpp:169-170), not a separate action.
export const PAD_DPAD_STEER = true;

// Retail profile defaults (GameProfile.cpp:48, 233-234): keyboard layout 0,
// controller configuration 0, camera 0 (Hollywood).
export const RETAIL_DEFAULTS = Object.freeze({
  keyboardLayout: 0,
  padConfig: 0,
  deadzone: DEFAULT_DEADZONE,
  cameraType: 0,
  steeringAssist: false,
  brakingAssist: false,
  abs: false,
  // Traction control is a per-car physics rule (car.cpp:1447-1465), not a
  // player option. Values are carried in _work/input/retail-input.json.
  tractionControl: 'physics'
});

function EMPTY_AXIS() {
  return Object.freeze({ negative: Object.freeze([]), positive: Object.freeze([]) });
}

/** Copy a partial action map into the full 29-action map (unbound = []). */
function emptyThen(partial) {
  const out = {};
  for (const id of ACTION_IDS) out[id] = Object.freeze([]);
  for (const [id, codes] of Object.entries(partial)) {
    if (!ACTION_BY_ID[id]) throw new Error('unknown action in retail table: ' + id);
    out[id] = Object.freeze(codes.slice());
  }
  return Object.freeze(out);
}

export function keyboardLayout(id) {
  const layout = KEYBOARD_LAYOUTS.find((entry) => entry.id === id);
  if (!layout) throw new Error('unknown keyboard layout ' + id + ' (use 0 or 1)');
  return layout;
}

export function padConfig(id) {
  const config = PAD_CONFIGS.find((entry) => entry.id === id);
  if (!config) throw new Error('unknown pad config ' + id + ' (use 0, 1 or 2)');
  return config;
}

// ---------------------------------------------------------------------------
// Bindings: mutable, serialisable and validated.
// ---------------------------------------------------------------------------

export function createDefaultBindings(options = {}) {
  const layout = keyboardLayout(options.keyboardLayout ?? RETAIL_DEFAULTS.keyboardLayout);
  const config = padConfig(options.padConfig ?? RETAIL_DEFAULTS.padConfig);
  return {
    schema: BINDINGS_SCHEMA,
    version: BINDINGS_VERSION,
    keyboardLayout: layout.id,
    padConfig: config.id,
    deadzone: options.deadzone ?? DEFAULT_DEADZONE,
    keyboard: {
      actions: cloneMap(layout.actions),
      axes: {
        steer: {
          negative: layout.axes.steer.negative.slice(),
          positive: layout.axes.steer.positive.slice()
        },
        pitch: { negative: [], positive: [] }
      }
    },
    pad: {
      actions: cloneMap(config.actions),
      axes: { ...PAD_AXIS_ROLES }
    }
  };
}

function cloneMap(map) {
  const out = {};
  for (const id of ACTION_IDS) out[id] = (map[id] ?? []).slice();
  return out;
}

export function cloneBindings(bindings) {
  return JSON.parse(JSON.stringify(bindings));
}

const KEY_CODE_RE = /^[A-Za-z0-9]{1,32}$/;

export function validateBindings(bindings) {
  const problems = [];
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) {
    return ['bindings must be an object'];
  }
  if (bindings.schema !== BINDINGS_SCHEMA) problems.push('schema must be ' + BINDINGS_SCHEMA);
  if (bindings.version !== BINDINGS_VERSION) problems.push('version must be ' + BINDINGS_VERSION);
  if (![0, 1].includes(bindings.keyboardLayout)) problems.push('keyboardLayout must be 0 or 1');
  if (![0, 1, 2].includes(bindings.padConfig)) problems.push('padConfig must be 0, 1 or 2');
  if (!Number.isFinite(bindings.deadzone) || bindings.deadzone < 0 || bindings.deadzone >= 0.9) {
    problems.push('deadzone must be a finite number in [0, 0.9)');
  }
  if (!bindings.keyboard || typeof bindings.keyboard !== 'object') {
    problems.push('keyboard block missing');
  } else {
    validateActionMap(bindings.keyboard.actions, 'keyboard', problems, KEY_CODE_RE);
    const steer = bindings.keyboard.axes?.steer;
    if (!steer || !Array.isArray(steer.negative) || !Array.isArray(steer.positive)) {
      problems.push('keyboard.axes.steer must have negative/positive arrays');
    } else {
      validateCodeList(steer.negative, 'keyboard steer negative', problems, KEY_CODE_RE);
      validateCodeList(steer.positive, 'keyboard steer positive', problems, KEY_CODE_RE);
    }
  }
  if (!bindings.pad || typeof bindings.pad !== 'object') {
    problems.push('pad block missing');
  } else {
    validateActionMap(bindings.pad.actions, 'pad', problems, null);
    const axes = bindings.pad.axes;
    if (!axes || typeof axes !== 'object') {
      problems.push('pad.axes missing');
    } else {
      for (const role of ['steer', 'pitch', 'lookX', 'lookY']) {
        if (!PAD_AXIS_INDEX[axes[role]] && PAD_AXIS_INDEX[axes[role]] !== 0) {
          problems.push('pad.axes.' + role + ' must be a pad axis name');
        }
      }
    }
  }
  return problems;
}

function validateActionMap(map, device, problems, codeRe) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) {
    problems.push(device + '.actions must be an object');
    return;
  }
  for (const id of Object.keys(map)) {
    if (!ACTION_BY_ID[id]) problems.push('unknown action id ' + id);
  }
  for (const id of ACTION_IDS) {
    const list = map[id];
    if (list !== undefined) {
      if (!Array.isArray(list)) problems.push(device + '.' + id + ' must be an array');
      else validateCodeList(list, device + '.' + id, problems, codeRe);
    }
  }
}

function validateCodeList(list, label, problems, codeRe) {
  if (!Array.isArray(list)) {
    problems.push(label + ' must be an array');
    return;
  }
  if (list.length > 8) problems.push(label + ' has too many bindings');
  const seen = new Set();
  for (const code of list) {
    if (typeof code !== 'string' || !code) {
      problems.push(label + ' binding must be a non-empty string');
      continue;
    }
    if (codeRe && !codeRe.test(code)) problems.push(label + ' has an invalid browser code ' + code);
    if (codeRe === null && !PAD_BUTTON_INDEX[code] && PAD_BUTTON_INDEX[code] !== 0) {
      problems.push(label + ' has an unknown pad button ' + code);
    }
    if (seen.has(code)) problems.push(label + ' repeats ' + code);
    seen.add(code);
  }
}

// ---------------------------------------------------------------------------
// Device normalisation.
// ---------------------------------------------------------------------------

/**
 * Retail ApplyCircularDeadzone (Input.cpp:10-32): radial deadzone with linear
 * rescale to [0, 1]. `deadzone = 0` is the identity except for the unit clamp.
 * @returns {[number, number]}
 */
export function applyRadialDeadzone(x, y, deadzone = DEFAULT_DEADZONE) {
  const dx = Number.isFinite(x) ? x : 0;
  const dy = Number.isFinite(y) ? y : 0;
  if (!(deadzone > 0)) {
    const length = Math.hypot(dx, dy);
    if (length <= 1) return [dx, dy];
    return [dx / length, dy / length];
  }
  const length2 = dx * dx + dy * dy;
  const deadzone2 = deadzone * deadzone;
  if (length2 <= deadzone2) return [0, 0];
  const length = Math.sqrt(length2);
  let newLength = (length - deadzone) / (1 - deadzone);
  if (newLength > 1) newLength = 1;
  const ratio = newLength / length;
  return [dx * ratio, dy * ratio];
}

/** Retail signed-square steering target: x * |x| (car.cpp:818). */
export function steerCurve(x) {
  return x * Math.abs(x);
}

/** Retail exponential smoothing (car.cpp:799-828). */
export function smoothAxis(previous, target, smoothTime, dt) {
  const tau = Math.max(0, Number.isFinite(smoothTime) ? smoothTime : 0);
  const step = Math.max(0, Number.isFinite(dt) ? dt : 0);
  const factor = Math.exp(-step / (tau + 0.001));
  return previous * factor + target * (1 - factor);
}

export function createShaping() {
  return { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
}

/**
 * Advance the retail physics shaping preview by one fixed step. This is what
 * the retail car does to the control values; the e1 wasm does it internally,
 * so do NOT pass `shaped` back into `e1_set_input`.
 */
export function advanceShaping(shaping, controls, params = {}, dt = 1 / 60) {
  const p = { ...DEFAULT_CAR_INPUT_PARAMS, ...params };
  return {
    throttle: smoothAxis(shaping.throttle, clamp(controls.throttle, 0, 1), p.throttleSmoothTime, dt),
    brake: smoothAxis(shaping.brake, clamp(controls.brake, 0, 1), p.brakeSmoothTime, dt),
    steer: smoothAxis(shaping.steer, steerCurve(clamp(controls.steer, -1, 1)), p.steerSmoothTime, dt),
    handbrake: smoothAxis(shaping.handbrake, clamp(controls.handbrake, 0, 1), p.handbrakeSmoothTime, dt)
  };
}

// ---------------------------------------------------------------------------
// Net input (net-mvp protocol.mjs:204-227): { throttle, brake, steer, handbrake }
// in [-1, 1], quantised to 4 decimals.
// ---------------------------------------------------------------------------

export function quantizeNetInput(input, digits = 4) {
  const factor = 10 ** digits;
  const round = (value) => Math.round(value * factor) / factor;
  return {
    throttle: round(input.throttle),
    brake: round(input.brake),
    steer: round(input.steer),
    handbrake: round(input.handbrake)
  };
}

export function validateNetInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'input must be an object';
  const ranges = { throttle: [0, 1], brake: [0, 1], steer: [-1, 1], handbrake: [0, 1] };
  for (const [field, [min, max]] of Object.entries(ranges)) {
    const value = input[field];
    if (typeof value !== 'number' || !Number.isFinite(value)) return 'input.' + field + ' must be a finite number';
    if (value < min || value > max) return 'input.' + field + ' must be in [' + min + ', ' + max + ']';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Deterministic state export.
// ---------------------------------------------------------------------------

export function canonicalJson(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite number in input state');
    return JSON.stringify(value);
  }
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  }
  throw new Error('unsupported value in input state: ' + typeof value);
}

/** FNV-1a 32-bit over the canonical JSON; dependency-free and stable. */
export function hashState(value) {
  const text = typeof value === 'string' ? value : canonicalJson(value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return 'fnv1a32:' + hash.toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// Browser sources and a deterministic stub.
// ---------------------------------------------------------------------------

export function browserGamepadSource() {
  return () => {
    const nav = typeof navigator !== 'undefined' ? navigator : null;
    if (!nav || typeof nav.getGamepads !== 'function') return [];
    try {
      return Array.from(nav.getGamepads() || []);
    } catch {
      return [];
    }
  };
}

/**
 * Deterministic standard-mapping gamepad stub for tests and replay. Buttons are
 * objects with `{ pressed, touched, value }` like the real Gamepad API.
 */
export function createGamepadStub(options = {}) {
  const index = options.index ?? 0;
  const pad = {
    index,
    id: options.id ?? 'stub-standard-gamepad',
    connected: options.connected ?? true,
    mapping: options.mapping ?? 'standard',
    timestamp: 0,
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
    setAxis(axis, value) {
      pad.axes[axis] = value;
      pad.timestamp += 1;
      return pad;
    },
    setButton(button, value) {
      const node = pad.buttons[button];
      const numeric = typeof value === 'number' ? value : (value ? 1 : 0);
      node.value = numeric;
      node.pressed = numeric > 0;
      node.touched = numeric > 0;
      pad.timestamp += 1;
      return pad;
    },
    disconnect() {
      pad.connected = false;
      pad.axes = [0, 0, 0, 0];
      for (const node of pad.buttons) {
        node.value = 0;
        node.pressed = false;
        node.touched = false;
      }
      pad.timestamp += 1;
      return pad;
    },
    connect() {
      pad.connected = true;
      pad.timestamp += 1;
      return pad;
    }
  };
  for (const [axis, value] of Object.entries(options.axes ?? {})) pad.setAxis(Number(axis), value);
  for (const [button, value] of Object.entries(options.buttons ?? {})) pad.setButton(Number(button), value);
  return pad;
}

export function createMemoryStore(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      data.set(key, String(value));
    },
    removeItem(key) {
      data.delete(key);
    },
    dump() {
      return Object.fromEntries(data);
    }
  };
}

export function getBrowserStore() {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    /* storage can be blocked; caller gets null */
  }
  return null;
}

// ---------------------------------------------------------------------------
// The layer.
// ---------------------------------------------------------------------------

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

function clamp01(value) {
  return clamp(value, 0, 1);
}

export class InputLayer {
  constructor(options = {}) {
    this.bindings = options.bindings
      ? cloneBindings(options.bindings)
      : createDefaultBindings(options);
    const problems = validateBindings(this.bindings);
    if (problems.length) throw new Error('invalid bindings: ' + problems.join('; '));

    this.steerSign = options.steerSign ?? 1;
    if (this.steerSign !== 1 && this.steerSign !== -1) {
      throw new Error('steerSign must be 1 or -1');
    }
    this.padIndex = options.padIndex ?? null;
    this.requireStandardMapping = options.requireStandardMapping ?? true;
    this.gamepadSource = options.gamepadSource ?? browserGamepadSource();
    this.mouseSource = options.mouseSource ?? null;
    this.shapePreview = options.shapePreview ?? false;
    this.carParams = { ...DEFAULT_CAR_INPUT_PARAMS, ...(options.carParams ?? {}) };
    this.shaping = createShaping();

    this.tick = 0;
    this.held = new Set();
    this.previousActions = Object.freeze(Object.fromEntries(ACTION_IDS.map((id) => [id, 0])));
    this.padDiagnostics = {
      connected: false,
      index: null,
      mapping: null,
      connects: 0,
      disconnects: 0,
      rejectedMappings: 0
    };
    this._netOverride = null;
    this._state = null;
    this._target = null;
    this._listeners = null;
  }

  // ---- keyboard ----------------------------------------------------------

  keyDown(code) {
    if (typeof code !== 'string' || !code) return false;
    this.held.add(code);
    return true;
  }

  keyUp(code) {
    return this.held.delete(code);
  }

  clearKeys() {
    const had = this.held.size;
    this.held.clear();
    return had;
  }

  attach(target, options = {}) {
    this.detach();
    if (!target || typeof target.addEventListener !== 'function') {
      throw new Error('attach needs an EventTarget');
    }
    const preventDefault = options.preventDefault ?? true;
    const onKeyDown = (event) => {
      if (!event || typeof event.code !== 'string') return;
      if (!this.isBoundCode(event.code)) return;
      if (preventDefault && PREVENT_DEFAULT_CODES.has(event.code) && typeof event.preventDefault === 'function') {
        event.preventDefault();
      }
      if (event.repeat) return;
      this.keyDown(event.code);
    };
    const onKeyUp = (event) => {
      if (!event || typeof event.code !== 'string') return;
      this.keyUp(event.code);
    };
    const onBlur = () => this.clearKeys();
    target.addEventListener('keydown', onKeyDown);
    target.addEventListener('keyup', onKeyUp);
    target.addEventListener('blur', onBlur);
    this._target = target;
    this._listeners = { onKeyDown, onKeyUp, onBlur };
    return this;
  }

  detach() {
    if (!this._target || !this._listeners) return this;
    const { onKeyDown, onKeyUp, onBlur } = this._listeners;
    this._target.removeEventListener('keydown', onKeyDown);
    this._target.removeEventListener('keyup', onKeyUp);
    this._target.removeEventListener('blur', onBlur);
    this._target = null;
    this._listeners = null;
    return this;
  }

  isBoundCode(code) {
    for (const id of ACTION_IDS) {
      if ((this.bindings.keyboard.actions[id] ?? []).includes(code)) return true;
    }
    const steer = this.bindings.keyboard.axes.steer;
    return steer.negative.includes(code) || steer.positive.includes(code);
  }

  // ---- bindings ----------------------------------------------------------

  setKeyboardLayout(id) {
    const layout = keyboardLayout(id);
    this.bindings.keyboardLayout = layout.id;
    this.bindings.keyboard.actions = cloneMap(layout.actions);
    this.bindings.keyboard.axes.steer = {
      negative: layout.axes.steer.negative.slice(),
      positive: layout.axes.steer.positive.slice()
    };
    return this;
  }

  setPadConfig(id) {
    const config = padConfig(id);
    this.bindings.padConfig = config.id;
    this.bindings.pad.actions = cloneMap(config.actions);
    return this;
  }

  setDeadzone(value) {
    if (!Number.isFinite(value) || value < 0 || value >= 0.9) {
      throw new Error('deadzone must be in [0, 0.9)');
    }
    this.bindings.deadzone = value;
    return this;
  }

  rebindAction(actionId, device, code) {
    this._requireAction(actionId);
    const codes = this._actionCodes(device, actionId);
    if (device === 'keyboard') {
      if (typeof code !== 'string' || !KEY_CODE_RE.test(code)) throw new Error('invalid keyboard code ' + code);
    } else if (device === 'pad') {
      if (typeof code !== 'string' || !(code in PAD_BUTTON_INDEX)) throw new Error('unknown pad button ' + code);
    } else {
      throw new Error('device must be keyboard or pad');
    }
    codes.length = 0;
    codes.push(code);
    return this;
  }

  addActionBinding(actionId, device, code) {
    this._requireAction(actionId);
    if (device !== 'keyboard' && device !== 'pad') throw new Error('device must be keyboard or pad');
    if (device === 'keyboard' && (typeof code !== 'string' || !KEY_CODE_RE.test(code))) {
      throw new Error('invalid keyboard code ' + code);
    }
    if (device === 'pad' && (typeof code !== 'string' || !(code in PAD_BUTTON_INDEX))) {
      throw new Error('unknown pad button ' + code);
    }
    const codes = this._actionCodes(device, actionId);
    if (codes.includes(code)) return this;
    if (codes.length >= 8) throw new Error('too many bindings for ' + actionId);
    codes.push(code);
    return this;
  }

  unbindAction(actionId, device, code) {
    this._requireAction(actionId);
    const codes = this._actionCodes(device, actionId);
    const index = codes.indexOf(code);
    if (index < 0) return false;
    codes.splice(index, 1);
    return true;
  }

  clearAction(actionId, device) {
    this._requireAction(actionId);
    this._actionCodes(device, actionId).length = 0;
    return this;
  }

  rebindSteer(negativeCode, positiveCode) {
    if (typeof negativeCode !== 'string' || typeof positiveCode !== 'string') {
      throw new Error('steer bindings must be browser codes');
    }
    this.bindings.keyboard.axes.steer = {
      negative: [negativeCode],
      positive: [positiveCode]
    };
    return this;
  }

  _actionCodes(device, actionId) {
    if (device !== 'keyboard' && device !== 'pad') throw new Error('device must be keyboard or pad');
    return this.bindings[device].actions[actionId];
  }

  _requireAction(actionId) {
    if (!ACTION_BY_ID[actionId]) throw new Error('unknown action ' + actionId);
  }

  serializeBindings() {
    return cloneBindings(this.bindings);
  }

  applyBindings(bindings) {
    const problems = validateBindings(bindings);
    if (problems.length) throw new Error('invalid bindings: ' + problems.join('; '));
    this.bindings = cloneBindings(bindings);
    return this;
  }

  resetBindings(options = {}) {
    this.bindings = createDefaultBindings({ ...this.bindings, ...options });
    return this;
  }

  findConflicts(device = 'keyboard') {
    const byCode = new Map();
    const add = (code, action, context) => {
      if (!code) return;
      if (!byCode.has(code)) byCode.set(code, []);
      byCode.get(code).push({ action, context });
    };
    for (const id of ACTION_IDS) {
      const codes = device === 'keyboard'
        ? this.bindings.keyboard.actions[id]
        : this.bindings.pad.actions[id];
      for (const code of codes ?? []) add(code, id, ACTION_CONTEXT[id]);
    }
    if (device === 'keyboard') {
      for (const code of this.bindings.keyboard.axes.steer.negative) add(code, 'steerLeft', 'driving');
      for (const code of this.bindings.keyboard.axes.steer.positive) add(code, 'steerRight', 'driving');
    }
    const conflicts = [];
    for (const [code, owners] of byCode) {
      const byContext = new Map();
      for (const owner of owners) {
        if (!byContext.has(owner.context)) byContext.set(owner.context, new Set());
        byContext.get(owner.context).add(owner.action);
      }
      for (const [context, actions] of byContext) {
        if (actions.size > 1) {
          conflicts.push({ device, code, context, actions: [...actions].sort() });
        }
      }
    }
    return conflicts.sort((a, b) => a.code.localeCompare(b.code) || a.context.localeCompare(b.context));
  }

  saveBindings(store = getBrowserStore(), key = 'blur.input.bindings') {
    if (!store || typeof store.setItem !== 'function') throw new Error('no binding store');
    store.setItem(key, JSON.stringify(this.serializeBindings()));
    return this;
  }

  loadBindings(store = getBrowserStore(), key = 'blur.input.bindings') {
    if (!store || typeof store.getItem !== 'function') throw new Error('no binding store');
    const text = store.getItem(key);
    if (text === null || text === undefined) return false;
    this.applyBindings(JSON.parse(text));
    return true;
  }

  // ---- sampling ----------------------------------------------------------

  sample(dt = 1 / 60) {
    this.tick += 1;
    const pad = this._readPad();
    const padActions = pad ? this._padActions(pad) : emptyActionValues();
    const keyboardActions = this._keyboardActions();
    const actions = {};
    for (const id of ACTION_IDS) {
      actions[id] = Math.max(keyboardActions[id], pad ? padActions[id] : 0);
    }

    const keyboardSteer = this._keyboardSteer();
    const padSteer = pad ? this._padSteer(pad) : 0;
    const steer = clamp(keyboardSteer + padSteer, -1, 1) * this.steerSign;

    const look = pad ? this._padLook(pad) : { x: 0, y: 0 };
    const mouse = this.mouseSource ? this.mouseSource() : null;
    const lookX = clamp(look.x + (Number.isFinite(mouse?.dx) ? mouse.dx : 0), -1, 1);
    let lookY = clamp(look.y + (Number.isFinite(mouse?.dy) ? mouse.dy : 0), -1, 1);
    const rearView = actions.rearView > ACTION_PRESS_THRESHOLD;
    if (rearView) {
      lookY = -1;
    }

    const handbrakeRaw = clamp01(actions.handbrake);
    const controls = {
      throttle: clamp01(actions.throttle),
      brake: clamp01(actions.brake),
      steer,
      handbrake: handbrakeRaw > HANDBRAKE_THRESHOLD ? 1 : 0,
      handbrakeRaw
    };
    let source = 'device';
    if (this._netOverride) {
      const net = this._netOverride;
      this._netOverride = null;
      source = 'net';
      controls.throttle = net.throttle;
      controls.brake = net.brake;
      controls.steer = net.steer;
      controls.handbrakeRaw = net.handbrake;
      controls.handbrake = net.handbrake > HANDBRAKE_THRESHOLD ? 1 : 0;
      actions.throttle = net.throttle;
      actions.brake = net.brake;
      actions.handbrake = net.handbrake;
    }

    const pressed = [];
    for (const id of ACTION_IDS) {
      if (actions[id] > ACTION_PRESS_THRESHOLD && this.previousActions[id] <= ACTION_PRESS_THRESHOLD) {
        pressed.push(id);
      }
    }
    this.previousActions = Object.freeze({ ...actions });

    if (this.shapePreview) {
      this.shaping = advanceShaping(this.shaping, controls, this.carParams, dt);
    }

    const state = {
      schema: INPUT_SCHEMA,
      version: INPUT_VERSION,
      tick: this.tick,
      source,
      devices: {
        keyboard: true,
        pad: {
          connected: pad !== null,
          index: pad ? pad.index ?? null : null,
          mapping: pad ? pad.mapping ?? null : null,
          connects: this.padDiagnostics.connects,
          disconnects: this.padDiagnostics.disconnects,
          rejectedMappings: this.padDiagnostics.rejectedMappings
        }
      },
      actions,
      pressed,
      axes: {
        steer: controls.steer,
        pitch: clamp((pad ? this._padPitch(pad) : 0), -1, 1),
        keyboardSteer,
        padSteer,
        lookX,
        lookY
      },
      controls,
      engineInput: [controls.throttle, controls.brake, controls.steer, controls.handbrake],
      netInput: quantizeNetInput({
        throttle: controls.throttle,
        brake: controls.brake,
        steer: controls.steer,
        handbrake: controls.handbrakeRaw
      }),
      camera: {
        changeViewPressed: pressed.includes('changeView'),
        rearView,
        lookX,
        lookY
      },
      raw: {
        heldKeys: [...this.held].sort(),
        padAxes: pad ? [0, 1, 2, 3].map((axis) => {
          const value = pad.axes?.[axis];
          return Number.isFinite(value) ? clamp(value, -1, 1) : 0;
        }) : [0, 0, 0, 0],
        padButtons: pad ? Array.from({ length: 16 }, (_, button) => {
          const node = pad.buttons?.[button];
          if (node === undefined || node === null) return 0;
          if (typeof node === 'number') return clamp01(Number.isFinite(node) ? node : 0);
          return Number.isFinite(Number(node.value)) ? clamp01(Number(node.value)) : (node.pressed ? 1 : 0);
        }) : new Array(16).fill(0)
      },
      shaping: this.shapePreview ? { ...this.shaping } : null,
      assists: {
        steeringAssist: RETAIL_DEFAULTS.steeringAssist,
        brakingAssist: RETAIL_DEFAULTS.brakingAssist,
        abs: RETAIL_DEFAULTS.abs,
        tractionControl: RETAIL_DEFAULTS.tractionControl
      }
    };
    this._state = Object.freeze(state);
    return this._state;
  }

  get state() {
    return this._state;
  }

  exportState() {
    if (!this._state) throw new Error('sample() has not been called');
    return this._state;
  }

  exportNetInput() {
    return { ...this.exportState().netInput };
  }

  stateJson() {
    return canonicalJson(this.exportState());
  }

  stateHash() {
    return hashState(this.exportState());
  }

  applyNetInput(input) {
    const problem = validateNetInput(input);
    if (problem) throw new Error('invalid net input: ' + problem);
    this._netOverride = {
      throttle: input.throttle,
      brake: input.brake,
      steer: input.steer,
      handbrake: input.handbrake
    };
    return this;
  }

  // ---- internals ---------------------------------------------------------

  _keyboardActions() {
    const out = emptyActionValues();
    for (const id of ACTION_IDS) {
      const codes = this.bindings.keyboard.actions[id] ?? [];
      out[id] = codes.some((code) => this.held.has(code)) ? 1 : 0;
    }
    return out;
  }

  _keyboardSteer() {
    const steer = this.bindings.keyboard.axes.steer;
    const negative = steer.negative.some((code) => this.held.has(code)) ? 1 : 0;
    const positive = steer.positive.some((code) => this.held.has(code)) ? 1 : 0;
    return positive - negative;
  }

  _readPad() {
    let pads;
    try {
      pads = this.gamepadSource() ?? [];
    } catch {
      pads = [];
    }
    pads = Array.from(pads);
    let candidate = null;
    if (this.padIndex !== null) {
      candidate = pads[this.padIndex] ?? null;
    } else {
      candidate = pads.find((pad) => pad && pad.connected) ?? null;
    }
    if (candidate && !candidate.connected) candidate = null;
    if (!candidate) {
      if (this.padDiagnostics.connected) {
        this.padDiagnostics.connected = false;
        this.padDiagnostics.index = null;
        this.padDiagnostics.mapping = null;
        this.padDiagnostics.disconnects += 1;
      }
      return null;
    }
    if (this.requireStandardMapping && candidate.mapping !== 'standard') {
      this.padDiagnostics.rejectedMappings += 1;
      if (this.padDiagnostics.connected) {
        this.padDiagnostics.connected = false;
        this.padDiagnostics.index = null;
        this.padDiagnostics.mapping = null;
        this.padDiagnostics.disconnects += 1;
      }
      return null;
    }
    if (!this.padDiagnostics.connected) {
      this.padDiagnostics.connected = true;
      this.padDiagnostics.connects += 1;
    }
    this.padDiagnostics.index = candidate.index ?? null;
    this.padDiagnostics.mapping = candidate.mapping ?? null;
    return candidate;
  }

  _padActions(pad) {
    const out = emptyActionValues();
    for (const id of ACTION_IDS) {
      const buttons = this.bindings.pad.actions[id] ?? [];
      let value = 0;
      for (const name of buttons) value = Math.max(value, readPadButton(pad, name));
      out[id] = value;
    }
    return out;
  }

  _padSteer(pad) {
    const [x, y] = this._padStick(pad, this.bindings.pad.axes.steer, this.bindings.pad.axes.pitch);
    const dpad = PAD_DPAD_STEER
      ? (readPadButton(pad, 'DPadRight') > HANDBRAKE_THRESHOLD ? 1 : 0) -
        (readPadButton(pad, 'DPadLeft') > HANDBRAKE_THRESHOLD ? 1 : 0)
      : 0;
    void y;
    return clamp(x + dpad, -1, 1);
  }

  _padPitch(pad) {
    const [, y] = this._padStick(pad, this.bindings.pad.axes.steer, this.bindings.pad.axes.pitch);
    const dpad = (readPadButton(pad, 'DPadUp') > HANDBRAKE_THRESHOLD ? 1 : 0) -
      (readPadButton(pad, 'DPadDown') > HANDBRAKE_THRESHOLD ? 1 : 0);
    return clamp(y + dpad, -1, 1);
  }

  _padLook(pad) {
    const [x, y] = this._padStick(pad, this.bindings.pad.axes.lookX, this.bindings.pad.axes.lookY);
    return { x, y };
  }

  _padStick(pad, xAxis, yAxis) {
    const rawX = readPadAxis(pad, xAxis);
    const rawY = readPadAxis(pad, yAxis);
    const [x, y] = applyRadialDeadzone(rawX, rawY, this.bindings.deadzone);
    return [x * PAD_AXIS_SIGN[xAxis], y * PAD_AXIS_SIGN[yAxis]];
  }
}

const PREVENT_DEFAULT_CODES = new Set([
  'Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown'
]);

function emptyActionValues() {
  const out = {};
  for (const id of ACTION_IDS) out[id] = 0;
  return out;
}

function readPadButton(pad, name) {
  const index = PAD_BUTTON_INDEX[name];
  if (index === undefined) return 0;
  const node = pad?.buttons?.[index];
  if (node === undefined || node === null) return 0;
  if (typeof node === 'number') return clamp01(Number.isFinite(node) ? node : 0);
  const value = Number(node.value);
  if (Number.isFinite(value)) return clamp01(value);
  return node.pressed ? 1 : 0;
}

function readPadAxis(pad, name) {
  const index = PAD_AXIS_INDEX[name];
  if (index === undefined) return 0;
  const value = pad?.axes?.[index];
  return Number.isFinite(value) ? clamp(value, -1, 1) : 0;
}

export function createInputLayer(options = {}) {
  return new InputLayer(options);
}

export const INPUT = Object.freeze({
  createInputLayer,
  InputLayer,
  DEFAULT_DEADZONE,
  DEFAULT_CAR_INPUT_PARAMS,
  RETAIL_DEFAULTS,
  KEYBOARD_LAYOUTS,
  PAD_CONFIGS,
  ACTIONS,
  ACTION_IDS
});
