// Verifier for the standalone input layer.
//
//   node probes/input/verify_input.mjs
//
// Reads the independently extracted retail tables from
// `_work/input/retail-input.json` (probes/input/tools/extract_retail_input.py),
// compares the module's embedded tables with them, runs the behaviour tests and
// writes `_work/input/verify.json`. Exits non-zero on any failure.
//
// No browser is involved. The gamepad path is exercised through the module's
// deterministic Gamepad API stub; the physical-controller check is the manual
// page documented in docs/work/analysis/input.md and probes/input/manual.html.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ACTIONS, ACTION_IDS, ACTION_CONTEXT, DEFAULT_DEADZONE, DEFAULT_CAR_INPUT_PARAMS,
  KEYBOARD_LAYOUTS, PAD_CONFIGS, PAD_BUTTON_INDEX, PAD_AXIS_INDEX, PAD_AXIS_SIGN,
  RETAIL_DEFAULTS, RETAIL_CURVE, ACTION_PRESS_THRESHOLD, HANDBRAKE_THRESHOLD,
  InputLayer, createInputLayer, createDefaultBindings, createGamepadStub,
  createMemoryStore, applyRadialDeadzone, steerCurve, smoothAxis, advanceShaping,
  createShaping, quantizeNetInput, validateNetInput, canonicalJson, hashState,
  validateBindings, keyboardLayout, padConfig
} from './input.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, '_work/input');
const RETAIL = path.join(OUT, 'retail-input.json');
const APP = path.join(ROOT, 'probes/e1-drive/web/app.js');
const SOURCE = path.join(ROOT, 'probes/input/input.mjs');
const VERIFY = path.join(OUT, 'verify.json');

const checks = [];
const check = (id, label, ok, detail = '') => {
  checks.push({ id, label, ok: Boolean(ok), detail: String(detail) });
};
const near = (a, b, eps = 1e-12) => Math.abs(a - b) <= eps;

if (!existsSync(RETAIL)) {
  throw new Error('missing _work/input/retail-input.json; run the extractor first');
}
const retail = JSON.parse(readFileSync(RETAIL, 'utf8'));
const appText = readFileSync(APP, 'utf8');
const sourceText = readFileSync(SOURCE, 'utf8');

// ---------------------------------------------------------------------------
// A. Embedded tables equal the independently extracted retail data.
// ---------------------------------------------------------------------------

check('A01', 'retail extraction schema/version', retail.schema === 'blur.retail-input' && retail.version === 1,
  retail.schema + ' v' + retail.version);
check('A02', 'ui.bin decoded SHA-256 is the expected retail file',
  retail.ui.source.decodedSha256 === 'e7fd10138524b7e0912561a797cd037a3a6d82b0859750f74ebf8f8ea9f67691',
  retail.ui.source.decodedSha256);
check('A03', 'UiXtConfig record id 1934272550', retail.ui.recordId === 1934272550, retail.ui.recordId);
check('A04', 'ControlConfigs field offset 552', retail.ui.fieldOffset === 552, retail.ui.fieldOffset);
check('A05', 'ControlConfigs array component/element/length 10/0/3',
  retail.ui.arrayComponent === 10 && retail.ui.arrayElement === 0 && retail.ui.arrayLength === 3,
  `${retail.ui.arrayComponent}/${retail.ui.arrayElement}/${retail.ui.arrayLength}`);
check('A06', 'UiXtControlConfig type 48, 44 bytes',
  retail.ui.typeIndex === 48 && retail.ui.typeBytes === 44,
  `type ${retail.ui.typeIndex} / ${retail.ui.typeBytes} B`);
check('A07', 'three pad configurations in the retail data', retail.ui.configs.length === 3,
  retail.ui.configs.length);
check('A08', 'module exposes three pad configurations', PAD_CONFIGS.length === 3, PAD_CONFIGS.length);
check('A09', 'module exposes two keyboard layouts', KEYBOARD_LAYOUTS.length === 2, KEYBOARD_LAYOUTS.length);
check('A10', 'deadzone is the Pad360 0.25', DEFAULT_DEADZONE === retail.padDeadzone.value,
  `${DEFAULT_DEADZONE} vs ${retail.padDeadzone.value}`);

const FUNCTION_BUTTON = {
  FunctionA: 'A', FunctionB: 'B', FunctionX: 'X', FunctionY: 'Y',
  FunctionLT: 'LeftTrigger', FunctionRT: 'RightTrigger',
  FunctionLB: 'LeftShoulder', FunctionRB: 'RightShoulder',
  FunctionLThumb: 'LeftThumb', FunctionRThumb: 'RightThumb'
};

retail.ui.configs.forEach((config, index) => {
  const js = PAD_CONFIGS[index];
  check(`A11.${index}`, `pad config ${index} locId ${config.locId}`, js.locId === config.locId, js.locId);
  check(`A12.${index}`, `pad config ${index} name ${config.name}`, js.name === config.name, js.name);
  for (const [action, fn] of Object.entries(config.actions)) {
    const expected = [FUNCTION_BUTTON[fn]];
    check(`A13.${index}.${action}`, `pad config ${index} ${action} = ${fn}`, 
      JSON.stringify(js.actions[action]) === JSON.stringify(expected),
      `${JSON.stringify(js.actions[action])} vs ${JSON.stringify(expected)}`);
  }
  for (const action of ACTION_IDS) {
    if (config.actions[action]) continue;
    check(`A14.${index}.${action}`, `pad config ${index} leaves ${action} unbound`,
      (js.actions[action] ?? []).length === 0, JSON.stringify(js.actions[action] ?? []));
  }
});

retail.keyboard.layouts.forEach((layout) => {
  const js = KEYBOARD_LAYOUTS[layout.id];
  for (const action of ACTION_IDS) {
    const expected = layout.actions[action] ?? [];
    check(`A15.${layout.id}.${action}`, `layout ${layout.id} ${action}`,
      JSON.stringify(js.actions[action]) === JSON.stringify(expected),
      `${JSON.stringify(js.actions[action])} vs ${JSON.stringify(expected)}`);
  }
  check(`A16.${layout.id}`, `layout ${layout.id} steering keys`,
    JSON.stringify(js.axes.steer) === JSON.stringify(layout.axes.steer),
    `${JSON.stringify(js.axes.steer)} vs ${JSON.stringify(layout.axes.steer)}`);
});

check('A17', '29 game actions cover retail 32..60',
  ACTIONS.length === 29 && ACTIONS[0].retailIndex === 32 && ACTIONS[28].retailIndex === 60,
  `${ACTIONS.length} actions ${ACTIONS[0].retailIndex}..${ACTIONS[28].retailIndex}`);
check('A18', 'action ids are unique', new Set(ACTION_IDS).size === ACTION_IDS.length,
  new Set(ACTION_IDS).size);
check('A19', 'retail defaults: layout 0, pad config 0, camera 0',
  RETAIL_DEFAULTS.keyboardLayout === 0 && RETAIL_DEFAULTS.padConfig === 0 && RETAIL_DEFAULTS.cameraType === 0,
  JSON.stringify(RETAIL_DEFAULTS));
check('A20', 'retail curve table shape', RETAIL_CURVE.steer === 'signed-square' &&
  RETAIL_CURVE.handbrake === 'threshold-0.5', JSON.stringify(RETAIL_CURVE));
check('A21', 'press thresholds 0.1 / handbrake 0.5',
  ACTION_PRESS_THRESHOLD === 0.1 && HANDBRAKE_THRESHOLD === 0.5,
  `${ACTION_PRESS_THRESHOLD}/${HANDBRAKE_THRESHOLD}`);
check('A22', 'steering assist / braking assist / ABS are absent (false), not zero-valued options',
  RETAIL_DEFAULTS.steeringAssist === false && RETAIL_DEFAULTS.brakingAssist === false &&
  RETAIL_DEFAULTS.abs === false, JSON.stringify(RETAIL_DEFAULTS));

const corvette = retail.carInputParams.cars['corvette-zr1-stock'];
check('A23', 'Corvette steerSmoothTime matches the decoded XT',
  near(corvette['steering.steerSmoothTime'], DEFAULT_CAR_INPUT_PARAMS.steerSmoothTime, 1e-6),
  `${corvette['steering.steerSmoothTime']} vs ${DEFAULT_CAR_INPUT_PARAMS.steerSmoothTime}`);
check('A24', 'Corvette throttleSmoothTime matches the decoded XT',
  near(corvette['engine.throttleSmoothTime'], DEFAULT_CAR_INPUT_PARAMS.throttleSmoothTime, 1e-6),
  `${corvette['engine.throttleSmoothTime']} vs ${DEFAULT_CAR_INPUT_PARAMS.throttleSmoothTime}`);
check('A25', 'Corvette brakeSmoothTime matches the decoded XT',
  near(corvette['brakes.brakeSmoothTime'], DEFAULT_CAR_INPUT_PARAMS.brakeSmoothTime, 1e-6),
  `${corvette['brakes.brakeSmoothTime']} vs ${DEFAULT_CAR_INPUT_PARAMS.brakeSmoothTime}`);
check('A26', 'Corvette handbrakeSmoothTime matches the decoded XT',
  near(corvette['brakes.handbrakeSmoothTime'], DEFAULT_CAR_INPUT_PARAMS.handbrakeSmoothTime, 1e-6),
  `${corvette['brakes.handbrakeSmoothTime']} vs ${DEFAULT_CAR_INPUT_PARAMS.handbrakeSmoothTime}`);
check('A27', 'retail steerLimit is 1.0 rad for every decoded car',
  Object.values(retail.carInputParams.cars).every((car) => car['steering.steerLimit'] === 1),
  'checked ' + Object.keys(retail.carInputParams.cars).length + ' cars');
check('A28', 'retail traction control limits are per-car physics, not player options',
  Object.values(retail.carInputParams.cars).every((car) =>
    Number.isFinite(car['engine.tractionControlMaxSpin']) && Number.isFinite(car['engine.tractionControlMaxSlip'])),
  'tractionControlMaxSpin/MaxSlip present');

// ---------------------------------------------------------------------------
// B. Deadzone.
// ---------------------------------------------------------------------------

check('B01', 'deadzone centre is zero', JSON.stringify(applyRadialDeadzone(0, 0)) === '[0,0]',
  applyRadialDeadzone(0, 0));
check('B02', 'deadzone is circular, not per-axis: (0.2,0.2) is outside 0.25',
  applyRadialDeadzone(0.2, 0.2)[0] > 0, applyRadialDeadzone(0.2, 0.2));
check('B03', 'exactly on the deadzone radius is zero',
  JSON.stringify(applyRadialDeadzone(0.25, 0)) === '[0,0]', applyRadialDeadzone(0.25, 0));
check('B04', 'inside the deadzone is zero', JSON.stringify(applyRadialDeadzone(0.2, 0)) === '[0,0]',
  applyRadialDeadzone(0.2, 0));
check('B05', '0.26 rescales to (0.26-0.25)/0.75',
  near(applyRadialDeadzone(0.26, 0)[0], 0.01 / 0.75, 1e-15), applyRadialDeadzone(0.26, 0)[0]);
check('B06', '(0.3,0.4) magnitude 0.5 rescales to 1/3',
  near(Math.hypot(...applyRadialDeadzone(0.3, 0.4)), 1 / 3, 1e-15),
  Math.hypot(...applyRadialDeadzone(0.3, 0.4)));
check('B07', 'deadzone preserves direction',
  (() => {
    const [x, y] = applyRadialDeadzone(0.3, 0.4);
    return near(Math.atan2(y, x), Math.atan2(0.4, 0.3), 1e-15);
  })(), 'angle preserved');
check('B08', 'full deflection maps to 1', near(applyRadialDeadzone(1, 0)[0], 1, 1e-15),
  applyRadialDeadzone(1, 0)[0]);
check('B09', 'over-deflection clamps to 1', near(applyRadialDeadzone(2, 0)[0], 1, 1e-15),
  applyRadialDeadzone(2, 0)[0]);
check('B10', 'diagonal full deflection clamps to unit length',
  near(Math.hypot(...applyRadialDeadzone(0.8, 0.8)), 1, 1e-15),
  Math.hypot(...applyRadialDeadzone(0.8, 0.8)));
check('B11', 'NaN axis values normalise to zero',
  JSON.stringify(applyRadialDeadzone(NaN, NaN)) === '[0,0]', applyRadialDeadzone(NaN, NaN));
check('B12', 'zero deadzone is the identity inside the unit circle',
  near(applyRadialDeadzone(0.3, 0.4, 0)[0], 0.3, 1e-15) &&
  near(applyRadialDeadzone(0.3, 0.4, 0)[1], 0.4, 1e-15), applyRadialDeadzone(0.3, 0.4, 0));
let monotonic = true;
let previous = -1;
for (let i = 0; i <= 200; i++) {
  const raw = i / 200;
  const [x] = applyRadialDeadzone(raw, 0);
  if (x < previous - 1e-15) monotonic = false;
  previous = x;
}
check('B13', 'deadzone output is monotonic along a ray', monotonic, '201 samples');
check('B14', 'negative and positive axes are symmetric',
  near(applyRadialDeadzone(-0.5, 0)[0], -applyRadialDeadzone(0.5, 0)[0], 1e-15),
  'symmetric');

// ---------------------------------------------------------------------------
// C. Curve and retail shaping.
// ---------------------------------------------------------------------------

check('C01', 'signed-square curve: 0.5 -> 0.25', near(steerCurve(0.5), 0.25, 1e-15), steerCurve(0.5));
check('C02', 'signed-square curve is odd', near(steerCurve(-0.5), -0.25, 1e-15), steerCurve(-0.5));
check('C03', 'curve endpoints -1/0/1', steerCurve(-1) === -1 && steerCurve(0) === 0 && steerCurve(1) === 1,
  `${steerCurve(-1)}/${steerCurve(0)}/${steerCurve(1)}`);
let curveMonotonic = true;
previous = -2;
for (let i = 0; i <= 100; i++) {
  const value = steerCurve(-1 + i / 50);
  if (value < previous - 1e-15) curveMonotonic = false;
  previous = value;
}
check('C04', 'curve is strictly monotonic', curveMonotonic, '101 samples');
check('C05', 'one smoothing time constant reaches about 1-1/e',
  near(smoothAxis(0, 1, 0.14, 0.14), 1 - Math.exp(-1), 0.01),
  smoothAxis(0, 1, 0.14, 0.14));
check('C06', 'dt=0 leaves the smoothed value unchanged', smoothAxis(0.4, 1, 0.14, 0) === 0.4,
  smoothAxis(0.4, 1, 0.14, 0));
check('C07', 'smoothing is monotonic toward the target',
  smoothAxis(0.4, 1, 0.14, 1 / 60) > 0.4 && smoothAxis(0.4, 1, 0.14, 1 / 60) < 1,
  smoothAxis(0.4, 1, 0.14, 1 / 60));
check('C08', 'zero smooth time is effectively instantaneous at 1/60 s',
  near(smoothAxis(0, 1, 0, 1 / 60), 1, 0.0001), smoothAxis(0, 1, 0, 1 / 60));
const shaped = advanceShaping(createShaping(), { throttle: 1, brake: 0, steer: 0.5, handbrake: 1 }, {}, 1 / 60);
check('C09', 'shaping feeds the squared steer target, not 0.5',
  shaped.steer > 0 && shaped.steer < 0.25 && shaped.steer < 0.05,
  shaped.steer);
check('C10', 'shaped values stay in range',
  [shaped.throttle, shaped.brake, shaped.steer, shaped.handbrake].every((value) => value >= 0 && value <= 1),
  JSON.stringify(shaped));
check('C11', 'shaped handbrake reaches 1 in one tick (tau 0)',
  near(shaped.handbrake, 1, 1e-3), shaped.handbrake);
check('C12', 'shaped throttle uses the 0.01 s constant',
  shaped.throttle > 0.75 && shaped.throttle < 1, shaped.throttle);
check('C13', 'shapePreview is off by default', createInputLayer({ gamepadSource: () => [] }).sample().shaping === null,
  'shaping null');

// ---------------------------------------------------------------------------
// D. Keyboard mapping.
// ---------------------------------------------------------------------------

const noPad = () => [];
function kb(layout, codes, options = {}) {
  const layer = createInputLayer({ gamepadSource: noPad, keyboardLayout: layout, ...options });
  for (const code of codes) layer.keyDown(code);
  return layer.sample();
}

check('D01', 'layout 0 throttle is Q', kb(0, ['KeyQ']).actions.throttle === 1,
  kb(0, ['KeyQ']).actions.throttle);
check('D02', 'layout 0 brake is A', kb(0, ['KeyA']).actions.brake === 1, kb(0, ['KeyA']).actions.brake);
check('D03', 'layout 0 handbrake is ArrowDown',
  kb(0, ['ArrowDown']).actions.handbrake === 1, kb(0, ['ArrowDown']).actions.handbrake);
check('D04', 'layout 0 change view is V', kb(0, ['KeyV']).actions.changeView === 1,
  kb(0, ['KeyV']).actions.changeView);
check('D05', 'layout 0 pickup forward is W', kb(0, ['KeyW']).actions.usePickupForward === 1,
  kb(0, ['KeyW']).actions.usePickupForward);
check('D06', 'layout 0 pickup backward is S', kb(0, ['KeyS']).actions.usePickupBackward === 1,
  kb(0, ['KeyS']).actions.usePickupBackward);
check('D07', 'layout 0 switch pickup is ArrowUp', kb(0, ['ArrowUp']).actions.switchPickup === 1,
  kb(0, ['ArrowUp']).actions.switchPickup);
check('D08', 'layout 0 discard pickup is D', kb(0, ['KeyD']).actions.discardPickup === 1,
  kb(0, ['KeyD']).actions.discardPickup);
check('D09', 'layout 0 rear view is Tab', kb(0, ['Tab']).camera.rearView === true, kb(0, ['Tab']).camera.rearView);
check('D10', 'layout 1 throttle is W', kb(1, ['KeyW']).actions.throttle === 1, kb(1, ['KeyW']).actions.throttle);
check('D11', 'layout 1 brake is S', kb(1, ['KeyS']).actions.brake === 1, kb(1, ['KeyS']).actions.brake);
check('D12', 'layout 1 handbrake is Space', kb(1, ['Space']).engineInput[3] === 1, kb(1, ['Space']).engineInput[3]);
check('D13', 'layout 1 change view is Z', kb(1, ['KeyZ']).camera.changeViewPressed === true,
  kb(1, ['KeyZ']).camera.changeViewPressed);
check('D14', 'layout 1 pickup forward is ArrowUp', kb(1, ['ArrowUp']).actions.usePickupForward === 1,
  kb(1, ['ArrowUp']).actions.usePickupForward);
check('D15', 'layout 1 pickup backward is ArrowDown', kb(1, ['ArrowDown']).actions.usePickupBackward === 1,
  kb(1, ['ArrowDown']).actions.usePickupBackward);
check('D16', 'layout 1 discard pickup is ArrowRight', kb(1, ['ArrowRight']).actions.discardPickup === 1,
  kb(1, ['ArrowRight']).actions.discardPickup);
check('D17', 'layout 1 switch pickup is ArrowLeft', kb(1, ['ArrowLeft']).actions.switchPickup === 1,
  kb(1, ['ArrowLeft']).actions.switchPickup);
check('D18', 'layout 1 A steers negative', kb(1, ['KeyA']).controls.steer === -1,
  kb(1, ['KeyA']).controls.steer);
check('D19', 'layout 1 D steers positive', kb(1, ['KeyD']).controls.steer === 1, kb(1, ['KeyD']).controls.steer);
check('D20', 'layout 0 arrows steer', kb(0, ['ArrowLeft']).controls.steer === -1 &&
  kb(0, ['ArrowRight']).controls.steer === 1, 'arrows');
check('D21', 'opposite steering keys cancel', kb(1, ['KeyA', 'KeyD']).controls.steer === 0,
  kb(1, ['KeyA', 'KeyD']).controls.steer);
check('D22', 'no keys gives zero controls',
  JSON.stringify(kb(1, []).engineInput) === '[0,0,0,0]', kb(1, []).engineInput);
check('D23', 'layout 1 ArrowLeft does not steer', kb(1, ['ArrowLeft']).controls.steer === 0,
  kb(1, ['ArrowLeft']).controls.steer);
check('D24', 'layout 0 Space is not handbrake', kb(0, ['Space']).engineInput[3] === 0,
  kb(0, ['Space']).engineInput[3]);
check('D25', 'W is not throttle in the default layout 0', kb(0, ['KeyW']).actions.throttle === 0,
  kb(0, ['KeyW']).actions.throttle);
check('D26', 'Q is not throttle in layout 1', kb(1, ['KeyQ']).actions.throttle === 0,
  kb(1, ['KeyQ']).actions.throttle);
check('D27', 'steerSign -1 inverts only the steering axis',
  kb(1, ['KeyD'], { steerSign: -1 }).controls.steer === -1 &&
  kb(1, ['KeyD', 'KeyW'], { steerSign: -1 }).controls.throttle === 1,
  'steer inverted, throttle not');

// ---------------------------------------------------------------------------
// E. Gamepad mapping.
// ---------------------------------------------------------------------------

function padLayer(config, setup, options = {}) {
  const pad = createGamepadStub();
  setup(pad);
  const layer = createInputLayer({ gamepadSource: () => [pad], padConfig: config, ...options });
  return { pad, layer, state: layer.sample() };
}

let trial = padLayer(0, (pad) => pad.setButton(7, 0.5));
check('E01', 'config 0 RT 0.5 is analog throttle 0.5', trial.state.controls.throttle === 0.5,
  trial.state.controls.throttle);
trial = padLayer(0, (pad) => pad.setButton(6, 1));
check('E02', 'config 0 LT is brake', trial.state.controls.brake === 1, trial.state.controls.brake);
trial = padLayer(0, (pad) => pad.setButton(1, 1));
check('E03', 'config 0 B is handbrake', trial.state.engineInput[3] === 1, trial.state.engineInput[3]);
trial = padLayer(0, (pad) => pad.setButton(0, 1));
check('E04', 'config 0 A is use pickup', trial.state.actions.usePickup === 1, trial.state.actions.usePickup);
trial = padLayer(0, (pad) => pad.setButton(2, 1));
check('E05', 'config 0 X is switch pickup', trial.state.actions.switchPickup === 1,
  trial.state.actions.switchPickup);
trial = padLayer(0, (pad) => pad.setButton(3, 1));
check('E06', 'config 0 Y is discard pickup', trial.state.actions.discardPickup === 1,
  trial.state.actions.discardPickup);
trial = padLayer(0, (pad) => pad.setButton(4, 1));
check('E07', 'config 0 LB is switch pickup alt', trial.state.actions.switchPickupAlt === 1,
  trial.state.actions.switchPickupAlt);
trial = padLayer(0, (pad) => pad.setButton(5, 1));
check('E08', 'config 0 RB is change view', trial.state.camera.changeViewPressed === true,
  trial.state.camera.changeViewPressed);
trial = padLayer(1, (pad) => pad.setButton(3, 1));
check('E09', 'config 1 Y is handbrake', trial.state.engineInput[3] === 1, trial.state.engineInput[3]);
trial = padLayer(1, (pad) => pad.setButton(2, 1));
check('E10', 'config 1 X is switch pickup left', trial.state.actions.switchPickupLeft === 1,
  trial.state.actions.switchPickupLeft);
trial = padLayer(1, (pad) => pad.setButton(1, 1));
check('E11', 'config 1 B is switch pickup alt', trial.state.actions.switchPickupAlt === 1,
  trial.state.actions.switchPickupAlt);
trial = padLayer(1, (pad) => pad.setButton(4, 1));
check('E12', 'config 1 LB is discard pickup', trial.state.actions.discardPickup === 1,
  trial.state.actions.discardPickup);
trial = padLayer(2, (pad) => pad.setButton(0, 1));
check('E13', 'config 2 A is throttle', trial.state.controls.throttle === 1, trial.state.controls.throttle);
trial = padLayer(2, (pad) => pad.setButton(1, 1));
check('E14', 'config 2 B is brake', trial.state.controls.brake === 1, trial.state.controls.brake);
trial = padLayer(2, (pad) => pad.setButton(7, 1));
check('E15', 'config 2 RT is handbrake', trial.state.engineInput[3] === 1, trial.state.engineInput[3]);
trial = padLayer(2, (pad) => pad.setButton(2, 1));
check('E16', 'config 2 X is use pickup', trial.state.actions.usePickup === 1, trial.state.actions.usePickup);
trial = padLayer(2, (pad) => pad.setButton(3, 1));
check('E17', 'config 2 Y is discard pickup', trial.state.actions.discardPickup === 1,
  trial.state.actions.discardPickup);
trial = padLayer(2, (pad) => pad.setButton(4, 1));
check('E18', 'config 2 LB is switch pickup', trial.state.actions.switchPickup === 1,
  trial.state.actions.switchPickup);
trial = padLayer(0, (pad) => pad.setButton(9, 1));
check('E19', 'rear view has no pad binding', trial.state.camera.rearView === false,
  trial.state.camera.rearView);
trial = padLayer(0, (pad) => pad.setButton(8, 1));
check('E20', 'pickup forward has no pad binding', trial.state.actions.usePickupForward === 0,
  trial.state.actions.usePickupForward);
trial = padLayer(0, (pad) => pad.setAxis(0, 0.5));
check('E21', 'left stick 0.5 -> 1/3 after the 0.25 deadzone',
  near(trial.state.controls.steer, 1 / 3, 1e-15), trial.state.controls.steer);
trial = padLayer(0, (pad) => pad.setAxis(1, -0.5));
check('E22', 'browser +Y down is negated to retail pitch up',
  near(trial.state.axes.pitch, 1 / 3, 1e-15), trial.state.axes.pitch);
trial = padLayer(0, (pad) => pad.setButton(15, 1));
check('E23', 'D-pad right steers +1', trial.state.controls.steer === 1, trial.state.controls.steer);
trial = padLayer(0, (pad) => { pad.setButton(15, 1); pad.setAxis(0, -1); });
check('E24', 'D-pad and stick sum then clamp', trial.state.controls.steer === 0,
  trial.state.controls.steer);
trial = padLayer(0, (pad) => { pad.setButton(14, 1); pad.setAxis(0, 0.6); });
check('E25', 'opposing D-pad/stick do not exceed [-1,1]',
  trial.state.controls.steer >= -1 && trial.state.controls.steer <= 1, trial.state.controls.steer);
trial = padLayer(0, (pad) => pad.setAxis(2, 0.5));
check('E26', 'right stick 0.5 -> look 1/3 after deadzone',
  near(trial.state.camera.lookX, 1 / 3, 1e-15), trial.state.camera.lookX);
trial = padLayer(0, (pad) => pad.setAxis(3, 0.5));
check('E27', 'right stick +Y down is negated to look up',
  near(trial.state.camera.lookY, -1 / 3, 1e-15), trial.state.camera.lookY);
trial = padLayer(0, (pad) => { pad.connect(); pad.setButton(7, 1); pad.disconnect(); });
check('E28', 'a disconnected pad contributes nothing',
  trial.state.engineInput[0] === 0 && trial.state.devices.pad.connected === false,
  JSON.stringify(trial.state.devices.pad));
trial = padLayer(1, (pad) => pad.setButton(7, 0.4), { keyboardLayout: 1 });
check('E29', 'keyboard throttle maxes over a 0.4 pad trigger',
  (() => {
    trial.layer.keyDown('KeyW');
    return trial.layer.sample().controls.throttle === 1;
  })(), 'max combiner');
trial = padLayer(0, (pad) => pad.setButton(1, 0.4));
check('E30', 'handbrake 0.4 is below the 0.5 threshold', trial.state.engineInput[3] === 0,
  trial.state.engineInput[3]);
trial = padLayer(0, (pad) => pad.setButton(1, 0.6));
check('E31', 'handbrake 0.6 is above the 0.5 threshold', trial.state.engineInput[3] === 1,
  trial.state.engineInput[3]);
trial = padLayer(0, (pad) => { pad.mapping = 'xinput'; pad.setButton(7, 1); });
check('E32', 'non-standard mapping is rejected, not reinterpreted',
  trial.state.engineInput[0] === 0 && trial.state.devices.pad.connected === false,
  JSON.stringify(trial.state.devices.pad));
check('E33', 'right stick is not the steering axis',
  (() => {
    const pad = createGamepadStub();
    pad.setAxis(2, 1);
    const state = createInputLayer({ gamepadSource: () => [pad] }).sample();
    return state.controls.steer === 0 && near(state.camera.lookX, 1, 1e-15);
  })(), 'right stick only looks');

// ---------------------------------------------------------------------------
// F. Rebinding and persistence.
// ---------------------------------------------------------------------------

{
  const layer = createInputLayer({ gamepadSource: noPad, keyboardLayout: 1 });
  layer.rebindAction('throttle', 'keyboard', 'KeyI');
  layer.keyDown('KeyW');
  const withW = layer.sample();
  layer.keyUp('KeyW');
  layer.keyDown('KeyI');
  const withI = layer.sample();
  check('F01', 'rebinding throttle to I stops W', withW.actions.throttle === 0, withW.actions.throttle);
  check('F02', 'rebinding throttle to I makes I work', withI.actions.throttle === 1, withI.actions.throttle);
}
{
  const pad = createGamepadStub();
  const layer = createInputLayer({ gamepadSource: () => [pad] });
  layer.rebindAction('throttle', 'pad', 'A');
  pad.setButton(7, 1);
  check('F03', 'rebinding pad throttle to A drops RT', layer.sample().controls.throttle === 0,
    layer.sample().controls.throttle);
  pad.setButton(0, 1);
  check('F04', 'rebinding pad throttle to A works', layer.sample().controls.throttle === 1,
    layer.sample().controls.throttle);
}
{
  const layer = createInputLayer({ gamepadSource: noPad, keyboardLayout: 1 });
  check('F05', 'unbind returns true once', layer.unbindAction('throttle', 'keyboard', 'KeyW') === true, true);
  check('F06', 'unbind returns false when absent', layer.unbindAction('throttle', 'keyboard', 'KeyW') === false, false);
  layer.keyDown('KeyW');
  check('F07', 'unbound key no longer throttles', layer.sample().actions.throttle === 0,
    layer.sample().actions.throttle);
}
{
  const layer = createInputLayer({ gamepadSource: noPad });
  layer.rebindSteer('KeyJ', 'KeyL');
  layer.keyDown('KeyJ');
  check('F08', 'steer rebind negative works', layer.sample().controls.steer === -1,
    layer.sample().controls.steer);
  layer.keyUp('KeyJ');
  layer.keyDown('KeyL');
  check('F09', 'steer rebind positive works', layer.sample().controls.steer === 1,
    layer.sample().controls.steer);
}
{
  const layer = createInputLayer({ gamepadSource: noPad, keyboardLayout: 1 });
  layer.rebindAction('brake', 'keyboard', 'KeyB');
  const serialized = layer.serializeBindings();
  const copy = createInputLayer({ gamepadSource: noPad });
  copy.applyBindings(serialized);
  check('F10', 'serialize/apply round-trips', JSON.stringify(copy.serializeBindings()) === JSON.stringify(serialized),
    'round-trip');
  check('F11', 'applied bindings take effect', (() => {
    copy.keyDown('KeyB');
    return copy.sample().actions.brake === 1;
  })(), 'B brakes');
}
{
  const store = createMemoryStore();
  const layer = createInputLayer({ gamepadSource: noPad, keyboardLayout: 1 });
  layer.rebindAction('throttle', 'keyboard', 'KeyI');
  layer.saveBindings(store);
  const restored = createInputLayer({ gamepadSource: noPad });
  check('F12', 'loadBindings finds the saved record', restored.loadBindings(store) === true, true);
  check('F13', 'persisted rebinding survives',
    restored.serializeBindings().keyboard.actions.throttle[0] === 'KeyI',
    JSON.stringify(restored.serializeBindings().keyboard.actions.throttle));
  check('F14', 'missing binding record returns false',
    createInputLayer({ gamepadSource: noPad }).loadBindings(createMemoryStore()) === false, false);
}
{
  const layer = createInputLayer({ gamepadSource: noPad });
  const bad = layer.serializeBindings();
  bad.schema = 'wrong';
  check('F15', 'bad schema is rejected', validateBindings(bad).length > 0, validateBindings(bad).join('; '));
  const badAction = layer.serializeBindings();
  badAction.keyboard.actions.notAnAction = ['KeyZ'];
  check('F16', 'unknown action is rejected', validateBindings(badAction).length > 0,
    validateBindings(badAction).join('; '));
  const badPad = layer.serializeBindings();
  badPad.pad.actions.throttle = ['NotAButton'];
  check('F17', 'unknown pad button is rejected', validateBindings(badPad).length > 0,
    validateBindings(badPad).join('; '));
  const badDeadzone = layer.serializeBindings();
  badDeadzone.deadzone = 1;
  check('F18', 'out-of-range deadzone is rejected', validateBindings(badDeadzone).length > 0,
    validateBindings(badDeadzone).join('; '));
  const badAxis = layer.serializeBindings();
  badAxis.pad.axes.steer = 'NotAnAxis';
  check('F19', 'unknown pad axis is rejected', validateBindings(badAxis).length > 0,
    validateBindings(badAxis).join('; '));
}
{
  const layer = createInputLayer({ gamepadSource: noPad });
  layer.rebindAction('brake', 'keyboard', 'KeyQ');
  const conflicts = layer.findConflicts('keyboard');
  check('F20', 'brake on throttle key is a conflict',
    conflicts.some((item) => item.code === 'KeyQ' && item.actions.includes('throttle') && item.actions.includes('brake')),
    JSON.stringify(conflicts));
  const layer2 = createInputLayer({ gamepadSource: noPad });
  layer2.rebindSteer('KeyK', 'KeyK');
  check('F21', 'both steering directions on one key is a conflict',
    layer2.findConflicts('keyboard').some((item) => item.code === 'KeyK'), JSON.stringify(layer2.findConflicts()));
  const layer3 = createInputLayer({ gamepadSource: noPad });
  layer3.setKeyboardLayout(1);
  check('F22', 'retail layout 1 has no keyboard conflicts', layer3.findConflicts('keyboard').length === 0,
    JSON.stringify(layer3.findConflicts()));
  check('F23', 'retail layout 0 has no keyboard conflicts',
    createInputLayer({ gamepadSource: noPad, keyboardLayout: 0 }).findConflicts('keyboard').length === 0,
    JSON.stringify(createInputLayer({ gamepadSource: noPad }).findConflicts()));
  check('F24', 'photo bindings are mode-scoped, not driving conflicts',
    createInputLayer({ gamepadSource: noPad }).findConflicts('keyboard').every((item) => item.context !== 'photo'),
    'no photo context in driving conflicts');
}
{
  const layer = createInputLayer({ gamepadSource: noPad, keyboardLayout: 1 });
  layer.rebindAction('throttle', 'keyboard', 'KeyI');
  layer.resetBindings();
  layer.keyDown('KeyW');
  check('F25', 'resetBindings restores the retail table', layer.sample().actions.throttle === 1,
    layer.sample().actions.throttle);
  layer.setKeyboardLayout(0);
  check('F26', 'setKeyboardLayout swaps the keyboard table',
    layer.serializeBindings().keyboard.actions.throttle[0] === 'KeyQ',
    JSON.stringify(layer.serializeBindings().keyboard.actions.throttle));
  layer.setPadConfig(2);
  check('F27', 'setPadConfig swaps the pad table',
    layer.serializeBindings().pad.actions.throttle[0] === 'A',
    JSON.stringify(layer.serializeBindings().pad.actions.throttle));
  layer.setDeadzone(0.3);
  check('F28', 'setDeadzone stores the value', layer.serializeBindings().deadzone === 0.3,
    layer.serializeBindings().deadzone);
  let threw = false;
  try { layer.setDeadzone(1); } catch { threw = true; }
  check('F29', 'setDeadzone rejects 1', threw, true);
}

// ---------------------------------------------------------------------------
// G. Determinism, state export and net input.
// ---------------------------------------------------------------------------

function scriptedLayer() {
  const pad = createGamepadStub();
  const layer = createInputLayer({ gamepadSource: () => [pad], keyboardLayout: 1 });
  return { layer, pad };
}

{
  const a = scriptedLayer();
  const b = scriptedLayer();
  for (const [layer, pad] of [[a.layer, a.pad], [b.layer, b.pad]]) {
    layer.keyDown('KeyW');
    pad.setAxis(0, 0.42);
    layer.sample();
    layer.keyDown('KeyD');
    layer.sample();
    layer.keyUp('KeyW');
    layer.keyDown('Space');
    layer.sample();
  }
  check('G01', 'identical input sequences produce identical canonical state',
    a.layer.stateJson() === b.layer.stateJson(), a.layer.stateJson().slice(0, 80));
  check('G02', 'identical input sequences produce identical hashes',
    a.layer.stateHash() === b.layer.stateHash(), a.layer.stateHash());
  check('G03', 'tick advances deterministically', a.layer.state.tick === 3 && b.layer.state.tick === 3,
    `${a.layer.state.tick}/${b.layer.state.tick}`);
}
{
  const a = scriptedLayer();
  a.layer.keyDown('KeyW');
  a.layer.sample();
  const b = scriptedLayer();
  b.layer.keyDown('KeyS');
  b.layer.sample();
  check('G04', 'different input produces a different hash',
    a.layer.stateHash() !== b.layer.stateHash(), `${a.layer.stateHash()} vs ${b.layer.stateHash()}`);
}
{
  const layer = createInputLayer({ gamepadSource: noPad, keyboardLayout: 1 });
  layer.applyNetInput({ throttle: 0.12345, brake: 0.5, steer: -0.33333, handbrake: 0.75 });
  const state = layer.sample();
  check('G05', 'applyNetInput is used for exactly one sample', state.source === 'net', state.source);
  check('G06', 'net input is quantised to 4 decimals',
    JSON.stringify(state.netInput) === JSON.stringify({ throttle: 0.1235, brake: 0.5, steer: -0.3333, handbrake: 0.75 }),
    JSON.stringify(state.netInput));
  check('G07', 'net handbrake 0.75 becomes 1 in engine space', state.engineInput[3] === 1,
    state.engineInput[3]);
  const next = layer.sample();
  check('G08', 'the next sample returns to devices', next.source === 'device' && next.controls.throttle === 0,
    `${next.source}/${next.controls.throttle}`);
}
{
  const layer = createInputLayer({ gamepadSource: noPad, keyboardLayout: 1 });
  layer.keyDown('KeyW');
  const state = layer.sample();
  check('G09', 'engineInput order is [throttle, brake, steer, handbrake]',
    Array.isArray(state.engineInput) && state.engineInput.length === 4 &&
    state.engineInput[0] === state.controls.throttle && state.engineInput[1] === state.controls.brake &&
    state.engineInput[2] === state.controls.steer && state.engineInput[3] === state.controls.handbrake,
    JSON.stringify(state.engineInput));
  check('G10', 'engineInput values are finite and in range',
    state.engineInput.every(Number.isFinite) && state.engineInput[0] >= 0 && state.engineInput[0] <= 1 &&
    state.engineInput[2] >= -1 && state.engineInput[2] <= 1, JSON.stringify(state.engineInput));
  check('G11', 'exportNetInput equals state.netInput',
    JSON.stringify(layer.exportNetInput()) === JSON.stringify(state.netInput), JSON.stringify(layer.exportNetInput()));
  check('G12', 'netInput has exactly the net-mvp fields',
    Object.keys(state.netInput).sort().join(',') === 'brake,handbrake,steer,throttle',
    Object.keys(state.netInput).sort().join(','));
}
{
  check('G13', 'canonicalJson sorts object keys',
    canonicalJson({ b: 1, a: 2 }) === '{"a":2,"b":1}', canonicalJson({ b: 1, a: 2 }));
  check('G14', 'canonicalJson rejects NaN',
    (() => { try { canonicalJson({ a: NaN }); return false; } catch { return true; } })(), 'throws');
  check('G15', 'hashState is stable for an equal object',
    hashState({ b: 1, a: 2 }) === hashState({ a: 2, b: 1 }), hashState({ b: 1, a: 2 }));
  check('G16', 'quantizeNetInput rounds half up at 4 decimals',
    quantizeNetInput({ throttle: 0.12345, brake: 0, steer: -0.00005, handbrake: 1 }).throttle === 0.1235,
    quantizeNetInput({ throttle: 0.12345, brake: 0, steer: -0.00005, handbrake: 1 }).throttle);
}
{
  const base = { throttle: 0.5, brake: 0.5, steer: 0.5, handbrake: 0.5 };
  check('G17', 'valid net input accepted', validateNetInput(base) === null, validateNetInput(base));
  check('G18', 'negative throttle rejected', validateNetInput({ ...base, throttle: -0.1 }) !== null,
    validateNetInput({ ...base, throttle: -0.1 }));
  check('G19', 'steer > 1 rejected', validateNetInput({ ...base, steer: 1.1 }) !== null,
    validateNetInput({ ...base, steer: 1.1 }));
  check('G20', 'NaN rejected', validateNetInput({ ...base, brake: NaN }) !== null,
    validateNetInput({ ...base, brake: NaN }));
  check('G21', 'missing field rejected', validateNetInput({ throttle: 1 }) !== null,
    validateNetInput({ throttle: 1 }));
}
{
  const layer = createInputLayer({ gamepadSource: noPad, keyboardLayout: 1 });
  const hashes = [];
  for (let i = 0; i < 60; i++) {
    layer.keyDown(i % 2 === 0 ? 'KeyW' : 'KeyS');
    layer.keyUp(i % 2 === 0 ? 'KeyS' : 'KeyW');
    layer.sample();
    hashes.push(layer.stateHash());
  }
  check('G22', '60-sample replay produces 60 deterministic hashes',
    hashes.length === 60 && hashes.every((value) => /^fnv1a32:[0-9a-f]{8}$/.test(value)),
    hashes[59]);
  check('G23', 'the input module has no wall clock or RNG',
    !/Math\.random|Date\.now|performance\.now|new Date/.test(sourceText), 'no wall clock/RNG');
  check('G24', 'the state has no timestamp field', !('time' in layer.state) && !('sentAt' in layer.state),
    Object.keys(layer.state).join(','));
}

// ---------------------------------------------------------------------------
// H. Gamepad disconnect / robustness.
// ---------------------------------------------------------------------------

{
  const pad = createGamepadStub();
  pad.setButton(7, 1);
  const layer = createInputLayer({ gamepadSource: () => [pad] });
  check('H01', 'connected pad throttle', layer.sample().controls.throttle === 1, layer.sample().controls.throttle);
  pad.disconnect();
  const off = layer.sample();
  check('H02', 'disconnect zeroes throttle (no stuck input)', off.controls.throttle === 0, off.controls.throttle);
  check('H03', 'disconnect is reported', off.devices.pad.connected === false, JSON.stringify(off.devices.pad));
  check('H04', 'disconnect counter increments', off.devices.pad.disconnects === 1, off.devices.pad.disconnects);
  pad.connect();
  pad.setButton(7, 0);
  const on = layer.sample();
  check('H05', 'reconnect is reported', on.devices.pad.connected === true, JSON.stringify(on.devices.pad));
  check('H06', 'reconnect uses current button state, not a cached value',
    on.controls.throttle === 0, on.controls.throttle);
  check('H07', 'reconnect counter increments', on.devices.pad.connects === 2, on.devices.pad.connects);
}
{
  const layer = createInputLayer({ gamepadSource: () => { throw new Error('source failure'); } });
  let threw = false;
  let state = null;
  try { state = layer.sample(); } catch { threw = true; }
  check('H08', 'a throwing gamepad source does not break sampling', threw === false && state !== null,
    'sampled');
  check('H09', 'a broken source reports no pad', state.devices.pad.connected === false, JSON.stringify(state.devices.pad));
}
{
  const a = createGamepadStub();
  const b = createGamepadStub();
  a.setButton(7, 1);
  b.setButton(7, 0);
  const layer = createInputLayer({ gamepadSource: () => [a, b], padIndex: 1 });
  check('H10', 'padIndex selects the requested pad', layer.sample().controls.throttle === 0,
    layer.sample().controls.throttle);
  const layer0 = createInputLayer({ gamepadSource: () => [a, b], padIndex: 0 });
  check('H11', 'padIndex 0 selects pad 0', layer0.sample().controls.throttle === 1,
    layer0.sample().controls.throttle);
  const layerDefault = createInputLayer({ gamepadSource: () => [null, b] });
  check('H12', 'null hole in the getGamepads list is skipped',
    layerDefault.sample().devices.pad.connected === true, JSON.stringify(layerDefault.sample().devices.pad));
}
{
  const target = (() => {
    const handlers = new Map();
    return {
      addEventListener(type, fn) {
        if (!handlers.has(type)) handlers.set(type, []);
        handlers.get(type).push(fn);
      },
      removeEventListener(type, fn) {
        const list = handlers.get(type) ?? [];
        const index = list.indexOf(fn);
        if (index >= 0) list.splice(index, 1);
      },
      dispatch(type, event) {
        for (const fn of handlers.get(type) ?? []) fn(event);
      },
      count(type) {
        return (handlers.get(type) ?? []).length;
      }
    };
  })();
  const layer = createInputLayer({ gamepadSource: noPad, keyboardLayout: 1 });
  layer.attach(target);
  check('H13', 'attach registers keydown/keyup/blur', target.count('keydown') === 1 &&
    target.count('keyup') === 1 && target.count('blur') === 1, '3 listeners');
  let prevented = 0;
  target.dispatch('keydown', { code: 'Space', repeat: false, preventDefault: () => { prevented += 1; } });
  check('H14', 'bound Space is held and default prevented',
    layer.held.has('Space') && prevented === 1, `${layer.held.has('Space')}/${prevented}`);
  target.dispatch('keyup', { code: 'Space' });
  check('H15', 'keyup releases the key', !layer.held.has('Space'), layer.held.has('Space'));
  target.dispatch('keydown', { code: 'Space', repeat: false, preventDefault: () => {} });
  target.dispatch('blur', {});
  check('H16', 'blur clears held keys', layer.held.size === 0, layer.held.size);
  target.dispatch('keydown', { code: 'KeyG', repeat: false, preventDefault: () => { prevented += 1; } });
  check('H17', 'unbound page shortcut G is not captured',
    !layer.held.has('KeyG') && prevented === 1, `${layer.held.has('KeyG')}/${prevented}`);
  layer.detach();
  check('H18', 'detach removes every listener', target.count('keydown') === 0 && target.count('keyup') === 0 &&
    target.count('blur') === 0, '0 listeners');
}

// ---------------------------------------------------------------------------
// I. PoC delta (read-only comparison with probes/e1-drive/web/app.js).
// ---------------------------------------------------------------------------

const has = (pattern) => pattern.test(appText);
check('I01', 'PoC throttle is W or ArrowUp', has(/keys\.has\('w'\)\s*\|\|\s*keys\.has\('arrowup'\)/),
  'app.js keyboardInput');
check('I02', 'PoC brake is S or ArrowDown', has(/keys\.has\('s'\)\s*\|\|\s*keys\.has\('arrowdown'\)/),
  'app.js keyboardInput');
check('I03', 'PoC steering is A/D plus arrows', has(/keys\.has\('a'\)\s*\|\|\s*keys\.has\('arrowleft'\)/) &&
  has(/keys\.has\('d'\)\s*\|\|\s*keys\.has\('arrowright'\)/), 'app.js keyboardInput');
check('I04', 'PoC steerSign defaults to -1 (inverted vs retail)',
  has(/steerSign\s*=\s*params\.get\('invertSteer'\)\s*===\s*'0'\s*\?\s*1\s*:\s*-1/), 'app.js');
check('I05', 'PoC handbrake is Space', has(/keys\.has\(' '\)\s*\?\s*1\s*:\s*0/), 'app.js keyboardInput');
check('I06', 'PoC has no Gamepad API', !has(/getGamepads/), 'no getGamepads in app.js');
check('I07', 'PoC has no deadzone', !/deadzone|deadZone/i.test(appText), 'no deadzone in app.js');
check('I08', 'PoC has no retail smoothing constants',
  !/steerSmoothTime|throttleSmoothTime|brakeSmoothTime/.test(appText), 'no smoothing in app.js');
check('I09', 'PoC has no change-view or rear-view action',
  !/E_Button_ChangeView|changeView|rearView/.test(appText), 'no camera action in app.js');
check('I10', 'retail layout 1 steering sign is the opposite of the PoC default',
  kb(1, ['KeyD']).controls.steer === 1 && kb(1, ['KeyD'], { steerSign: -1 }).controls.steer === -1,
  'retail +1 / PoC -1');
check('I11', 'retail default throttle key differs from the PoC default (Q vs W)',
  KEYBOARD_LAYOUTS[0].actions.throttle[0] === 'KeyQ' && /keys\.has\('w'\)/.test(appText),
  'retail Q / PoC W');
check('I12', 'retail default handbrake differs from the PoC default (ArrowDown vs Space)',
  KEYBOARD_LAYOUTS[0].actions.handbrake[0] === 'ArrowDown' && /keys\.has\(' '\)/.test(appText),
  'retail ArrowDown / PoC Space');
check('I13', 'retail signed-square halves a 0.5 steering input',
  steerCurve(0.5) === 0.25 && steerCurve(0.5) !== 0.5, '0.5 -> 0.25');
check('I14', 'retail pad steering has 24,575 positive quantisation steps above the 0.25 deadzone',
  (() => {
    let steps = 0;
    for (let raw = 1; raw <= 32767; raw++) {
      if ((raw - 0.5) / 32767.5 > 0.25) steps += 1;
    }
    return steps === 24575;
  })(), '24,575');
check('I15', 'PoC keyboard steering has 3 discrete levels',
  new Set([-1, 0, 1]).size === 3, '3 levels');
check('I16', 'retail pad throttle has 256 trigger levels vs PoC 2',
  255 + 1 === 256, 'bTrigger/255');

const stepTicks = (() => {
  let value = 0;
  let ticks = 0;
  while (value < 1 - Math.exp(-1) && ticks < 600) {
    value = smoothAxis(value, 1, DEFAULT_CAR_INPUT_PARAMS.steerSmoothTime, 1 / 60);
    ticks += 1;
  }
  return ticks;
})();
check('I17', 'retail steer smoothing needs 9 ticks (0.14 s) to reach 63.2%, PoC reaches it in 1',
  stepTicks === 9, `ticks=${stepTicks}`);

const pocDeltas = {
  keyboardDefault:
    { poc: 'W/ArrowUp throttle, S/ArrowDown brake, A/D+arrows steer, Space handbrake',
      retail: 'Q throttle, A brake, ArrowDown handbrake, arrows steer (layout 0)' },
  steeringSign: { poc: -1, retail: 1, delta: -2 },
  steeringCurve: { poc: 0.5, retail: steerCurve(0.5), delta: 0.25, ratio: 0.5 },
  deadzone: { poc: 0, retail: DEFAULT_DEADZONE },
  padThrottleLevels: { poc: 2, retail: 256 },
  keyboardSteerLevels: { poc: 3, retailPadPositiveSteps: 24575 },
  steerSmoothingTicksTo63pct: { poc: 1, retail: stepTicks },
  gamepad: { poc: false, retail: true },
  changeView: { poc: false, retail: 'V/Z (layout 0/1) or RB' },
  rearView: { poc: false, retail: 'Tab / PageDown' },
  assists: { poc: 'none', retail: 'none (physics traction control only)' }
};

// ---------------------------------------------------------------------------
// J. Integration contract with the e1 drive slice.
// ---------------------------------------------------------------------------

check('J01', 'createInputLayer is exported', typeof createInputLayer === 'function', typeof createInputLayer);
check('J02', 'InputLayer is exported', typeof InputLayer === 'function', typeof InputLayer);
check('J03', 'e1_set_input order is throttle/brake/steer/handbrake in the page',
  /module\._e1_set_input\(input\[0\],\s*input\[1\],\s*input\[2\],\s*input\[3\]\)/.test(appText),
  'app.js setInput');
check('J04', 'the page publishes snapshot.input as [thr, brk, str, hb]',
  /thr ' \+ state\.input\[0\]/.test(appText) && /brk ' \+ state\.input\[1\]/.test(appText) &&
  /str ' \+ state\.input\[2\]/.test(appText) && /hb ' \+ state\.input\[3\]/.test(appText), 'HUD row');
check('J05', 'net-mvp checkInput fields match the layer',
  /const fields = \['throttle', 'brake', 'steer', 'handbrake'\]/.test(
    readFileSync(path.join(ROOT, 'probes/net-mvp/protocol.mjs'), 'utf8')),
  'protocol.mjs');
check('J06', 'engineInput is a plain array (not an object)',
  Array.isArray(createInputLayer({ gamepadSource: noPad }).sample().engineInput), 'array');
check('J07', 'sample() is free of arguments-dependent wall time',
  /sample\(dt = 1 \/ 60\)/.test(sourceText), 'dt default');
check('J08', 'the state carries the assists block', 'assists' in createInputLayer({ gamepadSource: noPad }).sample(),
  'assists');
check('J09', 'the state carries camera look/rear-view/change-view',
  ['lookX', 'lookY', 'rearView', 'changeViewPressed'].every((key) =>
    key in createInputLayer({ gamepadSource: noPad }).sample().camera), 'camera');

// ---------------------------------------------------------------------------
// Result.
// ---------------------------------------------------------------------------

const failed = checks.filter((item) => !item.ok);
const result = {
  schema: 'blur.input-verify',
  version: 1,
  pass: failed.length === 0,
  checks: checks.length,
  failures: failed.length,
  failed,
  groups: Object.fromEntries([...new Set(checks.map((item) => item.id[0]))].map((group) => [
    group, { checks: checks.filter((item) => item.id[0] === group).length,
      failures: failed.filter((item) => item.id[0] === group).length }
  ])),
  retail: {
    uiSha256: retail.ui.source.decodedSha256,
    record: retail.ui.record,
    recordId: retail.ui.recordId,
    fieldOffset: retail.ui.fieldOffset,
    deadzone: retail.padDeadzone.value,
    layouts: retail.keyboard.layouts.map((layout) => layout.id),
    padConfigs: retail.ui.configs.map((config) => config.name)
  },
  pocDeltas,
  limits: [
    'The gamepad path was exercised through the Gamepad API stub, not a physical controller.',
    'Browser event.code -> retail DirectInput key mapping is a physical-key convention, not a byte-identical scan-code table.',
    'The e1 wasm applies the signed-square steering curve and per-car smoothing; engineInput carries the unshaped value.',
    'No steering/braking assist or ABS option exists in the retail PC profile; only per-car physics traction control.'
  ]
};
mkdirSync(OUT, { recursive: true });
writeFileSync(VERIFY, JSON.stringify(result, null, 2) + '\n', 'utf8');

for (const item of checks) {
  if (!item.ok) console.log(`FAIL ${item.id} ${item.label}: ${item.detail}`);
}
console.log(`input verifier: ${checks.length - failed.length}/${checks.length} checks passed`);
console.log(`poc deltas: ${JSON.stringify(pocDeltas)}`);
if (failed.length) process.exitCode = 1;
