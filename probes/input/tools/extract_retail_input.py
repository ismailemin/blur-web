"""Recover the retail Blur PC input tables, read-only, with provenance.

Inputs (never modified):
  game-data/Blur/cache/gamedata.pak          -> \\gamedata\\xt\\ui.bin (ControlConfigs)
  upstream/.../GameControls/GameControls.cpp -> keyboard layout 0/1 tables
  upstream/.../input/Pad360.cpp              -> stick deadzone 0.25
  upstream/.../Car/car.cpp                   -> steer/throttle/brake/handbrake smoothing
  upstream/.../RaceLogicCore.cpp             -> throttle/steer/brake/handbrake reads
  upstream/.../AmaxCam/VehicleFeed.cpp       -> camera change / rear view / look axes
  _work/e1-drive/cars/*.fields               -> per-car steering/engine/brake XT floats

Output (regenerable, ignored):
  _work/input/retail-input.json

The XT decoder is the committed bounded reader probes/powerups/tools/xt_decode.py;
the PAK index reader is tools/inspect_asset_layout.py. No offset is guessed: the
XT reader validates every table and the script records the decoded record/field
identity it used. Keyboard layouts are parsed from the recovered retail source
table, not from an XT.
"""
from __future__ import annotations

import hashlib
import json
import re
import struct
import sys
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'tools'))
sys.path.insert(0, str(ROOT / 'probes' / 'powerups' / 'tools'))

from inspect_asset_layout import pak_index  # noqa: E402
import xt_decode  # noqa: E402

PAK = ROOT / 'game-data' / 'Blur' / 'cache' / 'gamedata.pak'
UI_ENTRY = '\\gamedata\\xt\\ui.bin'
GAME_CONTROLS = ROOT / 'upstream/BlurRebuilt/code/amax/game/Game/GameControls/GameControls.cpp'
PAD360 = ROOT / 'upstream/BlurRebuilt/code/mercury/library/util/input/source/input/Pad360.cpp'
CAR_CPP = ROOT / 'upstream/BlurRebuilt/code/mercury/library/physics/racingphysics/source/vehicles/Car/car.cpp'
RLC = ROOT / 'upstream/BlurRebuilt/code/amax/game/GameLogic/RaceLogicCore/Core/RaceLogicCore.cpp'
VEHICLE_FEED = ROOT / 'upstream/BlurRebuilt/code/amax/game/Game/AmaxCam/VehicleFeed.cpp'
GAME_PROFILE_H = ROOT / 'upstream/BlurRebuilt/code/amax/game/GameLogic/Profile/GameProfile.h'
INPUT_CPP = ROOT / 'upstream/BlurRebuilt/code/mercury/library/util/input/source/input/Input.cpp'
CARS = ROOT / '_work' / 'e1-drive' / 'cars'
OUT = ROOT / '_work' / 'input' / 'retail-input.json'

# C_Keyboard::E_Button_<name> -> browser KeyboardEvent.code. The browser code is
# the physical key; the retail enum is a DirectInput scan-code index. The names
# are the retail names (Keyboard.h:17-190).
KEY_CODES = {
    'Escape': 'Escape', 'Q': 'KeyQ', 'W': 'KeyW', 'E': 'KeyE', 'R': 'KeyR',
    'T': 'KeyT', 'Y': 'KeyY', 'U': 'KeyU', 'I': 'KeyI', 'O': 'KeyO', 'P': 'KeyP',
    'A': 'KeyA', 'S': 'KeyS', 'D': 'KeyD', 'F': 'KeyF', 'G': 'KeyG', 'H': 'KeyH',
    'J': 'KeyJ', 'K': 'KeyK', 'L': 'KeyL', 'Z': 'KeyZ', 'X': 'KeyX', 'C': 'KeyC',
    'V': 'KeyV', 'B': 'KeyB', 'N': 'KeyN', 'M': 'KeyM',
    'Tab': 'Tab', 'Space': 'Space', 'Return': 'Enter', 'Back': 'Backspace',
    'LControl': 'ControlLeft', 'RControl': 'ControlRight',
    'LShift': 'ShiftLeft', 'RShift': 'ShiftRight', 'LMenu': 'AltLeft', 'RMenu': 'AltRight',
    'Up': 'ArrowUp', 'Down': 'ArrowDown', 'Left': 'ArrowLeft', 'Right': 'ArrowRight',
    'Prior': 'PageUp', 'Next': 'PageDown', 'End': 'End', 'Home': 'Home',
    'Insert': 'Insert', 'Delete': 'Delete',
    'Add': 'NumpadAdd', 'Subtract': 'NumpadSubtract', 'Multiply': 'NumpadMultiply',
    'Divide': 'NumpadDivide', 'Decimal': 'NumpadDecimal',
    'NumPad0': 'Numpad0', 'NumPad1': 'Numpad1', 'NumPad2': 'Numpad2',
    'NumPad3': 'Numpad3', 'NumPad4': 'Numpad4', 'NumPad5': 'Numpad5',
    'NumPad6': 'Numpad6', 'NumPad7': 'Numpad7', 'NumPad8': 'Numpad8',
    'NumPad9': 'Numpad9', 'NumPadEnter': 'NumpadEnter',
    'F1': 'F1', 'F2': 'F2', 'F3': 'F3', 'F4': 'F4', 'F5': 'F5', 'F6': 'F6',
    'F7': 'F7', 'F8': 'F8', 'F9': 'F9', 'F10': 'F10', 'F11': 'F11', 'F12': 'F12',
}

ACTION_IDS = {
    'Throttle': 'throttle', 'Brake': 'brake', 'Handbrake': 'handbrake',
    'GearUp': 'gearUp', 'GearDown': 'gearDown', 'ChangeView': 'changeView',
    'ResetVehicle': 'resetVehicle', 'UsePickup': 'usePickup',
    'DiscardPickup': 'discardPickup', 'SwitchPickup': 'switchPickup',
    'SwitchPickupLeft': 'switchPickupLeft', 'SwitchPickupAlt': 'switchPickupAlt',
    'UseShield': 'useShield', 'UseSecondTierPickup': 'useSecondTierPickup',
    'Auto_Shuffle_Perks': 'autoShufflePerks', 'Convert_To_Health': 'convertToHealth',
    'Clone_Selected_Perk': 'cloneSelectedPerk', 'Fullhouse': 'fullhouse',
    'UsePickupAlt': 'usePickupAlt', 'PhotoRoll': 'photoRoll',
    'PhotoZoom': 'photoZoom', 'PhotoRollReset': 'photoRollReset',
    'PhotoZoomReset': 'photoZoomReset', 'FireSlot1': 'fireSlot1',
    'FireSlot2': 'fireSlot2', 'FireSlot3': 'fireSlot3', 'RearView': 'rearView',
    'UsePickupForward': 'usePickupForward', 'UsePickupBackward': 'usePickupBackward',
}
ALL_ACTION_IDS = sorted(set(ACTION_IDS.values()))

PAD_FUNCTIONS = [
    'FunctionA', 'FunctionB', 'FunctionX', 'FunctionY', 'FunctionLT',
    'FunctionRT', 'FunctionLB', 'FunctionRB', 'FunctionLThumb', 'FunctionRThumb',
]


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def f32(bits_hex: str) -> float:
    return struct.unpack('>f', bytes.fromhex(bits_hex))[0]


def read_ui_bin() -> tuple[bytes, dict]:
    index = pak_index(PAK)
    entry = next((row for row in index['entries'] if row['path'] == UI_ENTRY), None)
    if entry is None:
        raise SystemExit('missing ' + UI_ENTRY)
    with PAK.open('rb') as stream:
        stream.seek(entry['offset'])
        stored = stream.read(entry['stored_bytes'])
    inflater = zlib.decompressobj()
    decoded = inflater.decompress(stored, entry['logical_bytes'] + 1)
    if (len(decoded) != entry['logical_bytes'] or not inflater.eof or
            inflater.unused_data or inflater.unconsumed_tail):
        raise SystemExit('ui.bin decompression mismatch')
    return decoded, {
        'pak': str(PAK.relative_to(ROOT)).replace('\\', '/'),
        'pakSha256': sha256(PAK.read_bytes()),
        'path': entry['path'],
        'pakOffset': entry['offset'],
        'storedBytes': entry['stored_bytes'],
        'logicalBytes': entry['logical_bytes'],
        'decodedSha256': sha256(decoded),
    }


def parse_key(token: str):
    token = token.strip()
    if token == 'kNoKey':
        return None
    match = re.fullmatch(r'KEY\((\w+)\)', token)
    if not match:
        raise SystemExit('unparsed key token ' + token)
    name = match.group(1)
    if name not in KEY_CODES:
        raise SystemExit('no browser code for key ' + name)
    return KEY_CODES[name]


def slice_block(text: str, start_marker: str) -> tuple[int, str]:
    start = text.index(start_marker)
    open_brace = text.index('{', start)
    depth = 0
    for i in range(open_brace, len(text)):
        if text[i] == '{':
            depth += 1
        elif text[i] == '}':
            depth -= 1
            if depth == 0:
                return start, text[open_brace:i + 1]
    raise SystemExit('unterminated block ' + start_marker)


BUTTON_ROW = re.compile(
    r'\{\s*(E_Button_\w+)\s*,\s*\{\s*([^,]+?)\s*,\s*([^}]+?)\s*\}\s*,\s*(ON_KEYBOARD|NOWHERE)\s*\}',
    re.S)
AXIS_ROW = re.compile(
    r'\{\s*(E_Axis_\w+)\s*,\s*\{\s*([^,]+?)\s*,\s*([^}]+?)\s*\}\s*,\s*\{\s*([^,]+?)\s*,\s*([^}]+?)\s*\}\s*,\s*([^,]+?)\s*,\s*([^}]+?)\s*\}',
    re.S)


def parse_game_controls() -> dict:
    text = GAME_CONTROLS.read_text(encoding='utf-8', errors='strict')
    normal_start, normal = slice_block(text, 'static const C_KeyLayoutButton kKeyLayoutButtons[]')
    split_start, split = slice_block(text, 'static const C_KeyLayoutButton kKeyLayoutButtonsSplitScreen[]')
    axes_start, axes_text = slice_block(text, 'static const C_KeyLayoutAxis kKeyLayoutAxes[]')
    axes_split_start, axes_split_text = slice_block(text, 'static const C_KeyLayoutAxis kKeyLayoutAxesSplitScreen[]')

    def buttons(block):
        out = {}
        for match in BUTTON_ROW.finditer(block):
            action = ACTION_IDS[match.group(1)[len('E_Button_'):]]
            out[action] = [parse_key(match.group(2)), parse_key(match.group(3))]
        if len(out) != 18:
            raise SystemExit(f'expected 18 game-button rows, parsed {len(out)}')
        return out

    def axes(block):
        out = []
        for match in AXIS_ROW.finditer(block):
            out.append({
                'axis': match.group(1)[len('E_Axis_'):],
                'negative': [parse_key(match.group(2)), parse_key(match.group(3))],
                'positive': [parse_key(match.group(4)), parse_key(match.group(5))],
                'pad': match.group(6).strip(),
                'padPositive': match.group(7).strip(),
            })
        if len(out) != 6:
            raise SystemExit(f'expected 6 game-axis rows, parsed {len(out)}')
        return out

    def line_of(offset):
        return text.count('\n', 0, offset) + 1

    return {
        'source': str(GAME_CONTROLS.relative_to(ROOT)).replace('\\', '/'),
        'buttonsLine': line_of(normal_start),
        'buttonsSplitLine': line_of(split_start),
        'axesLine': line_of(axes_start),
        'axesSplitLine': line_of(axes_split_start),
        'normalActions': buttons(normal),
        'normalAxes': axes(axes_text),
        'splitScreen': {'actions': buttons(split), 'axes': axes(axes_split_text)},
    }


def build_layouts(controls: dict) -> list[dict]:
    layouts = []
    for column, name in (
        (0, 'retail keyboard layout 0: Q/A + arrow steering'),
        (1, 'retail keyboard layout 1: W/S + A/D steering'),
    ):
        actions = {}
        for action in ALL_ACTION_IDS:
            keys = controls['normalActions'].get(action)
            actions[action] = [keys[column]] if keys and keys[column] else []
        axes = {}
        for row in controls['normalAxes']:
            negative = row['negative'][column]
            positive = row['positive'][column]
            if row['axis'] == 'Steering':
                axes.setdefault('steer', {'negative': [], 'positive': []})
                if negative:
                    axes['steer']['negative'].append(negative)
                if positive:
                    axes['steer']['positive'].append(positive)
            elif row['axis'] == 'Pitch':
                axes.setdefault('pitch', {'negative': [], 'positive': []})
                if negative:
                    axes['pitch']['negative'].append(negative)
                if positive:
                    axes['pitch']['positive'].append(positive)
        layouts.append({'id': column, 'name': name, 'actions': actions, 'axes': axes})
    return layouts


def parse_deadzone() -> dict:
    text = PAD360.read_text(encoding='utf-8')
    match = re.search(r'm_StickDeadzone\((0\.25f)\)', text)
    if not match:
        raise SystemExit('deadzone literal not found')
    return {
        'value': float(match.group(1).rstrip('f')),
        'source': str(PAD360.relative_to(ROOT)).replace('\\', '/'),
        'line': text.count('\n', 0, match.start()) + 1,
        'constructor': 'C_Pad360::C_Pad360',
    }


def decode_ui(decoded: bytes) -> dict:
    flask = xt_decode.Flask(decoded)
    type_id = next((i for i in range(flask.tables['types']['count'])
                    if flask.type_name(i) == 'UiXtControlConfig'), None)
    if type_id is None:
        raise SystemExit('UiXtControlConfig type missing')
    config_record = next((r for r in range(flask.tables['records']['count'])
                          if flask.type_name(flask.record_type(r)) == 'UiXtConfig'), None)
    if config_record is None:
        raise SystemExit('UiXtConfig record missing')
    field = next(f for f in flask.all_fields(flask.record_type(config_record))
                 if f['name'] == 'ControlConfigs')
    array = flask.decode_record(config_record)['ControlConfigs']
    items = []
    for i, item in enumerate(array['items']):
        actions = {}
        for function in PAD_FUNCTIONS:
            entry = item.get(function)
            if not entry or entry['label'] == 'None':
                continue
            actions[ACTION_IDS[entry['label']]] = function
        items.append({
            'index': i,
            'locId': '0x' + item['name']['id'],
            'actions': actions,
            'raw': {key: value for key, value in item.items() if key != '$type'},
        })
    return {
        'typeIndex': type_id,
        'typeName': 'UiXtControlConfig',
        'typeBytes': flask.types[type_id][5],
        'record': config_record,
        'recordId': flask.record_id(config_record),
        'recordType': 'UiXtConfig',
        'field': 'ControlConfigs',
        'fieldOffset': field['offset'],
        'arrayComponent': array['component'],
        'arrayElement': array['element'],
        'arrayLength': array['length'],
        'configs': items,
    }


def resolve_loc_names(ids: list[str]) -> dict:
    path = ROOT / '_work' / 'loc' / 'all-loc.json'
    if not path.exists():
        return {}
    data = json.loads(path.read_text(encoding='utf-8'))
    wanted = {int(i, 16): i for i in ids}
    found = {}
    for _file, table in data.items():
        for key, name in table.get('keys', []):
            if key in wanted:
                found[wanted[key]] = name
    return found


def parse_car_params() -> dict:
    wanted = [
        'mass.mass', 'steering.steerLimit', 'steering.ackerman',
        'steering.steerSmoothTime', 'steering.steerDirect', 'steering.steerDamping',
        'steering.reverseSteerDamping', 'steering.steerSpringDrift',
        'steering.steerSpringCentre', 'steering.steerSpringLowSpeed',
        'steering.slideRecovery', 'steering.antiflick', 'steering.antiflickThreshold',
        'engine.throttleSmoothTime', 'engine.tractionControlMaxSpin',
        'engine.tractionControlMaxSlip', 'engine.wheelSpinMaxSpeed_Mph',
        'brakes.brakeSmoothTime', 'brakes.handbrakeSmoothTime', 'brakes.handbrakeForce',
    ]
    cars = {}
    for path in sorted(CARS.glob('*.fields')):
        values = {}
        for line in path.read_text(encoding='utf-8').splitlines():
            if '\t' not in line:
                continue
            name, bits = line.split('\t', 1)
            if name in wanted:
                values[name] = f32(bits)
        cars[path.stem] = values
    return {
        'source': '_work/e1-drive/cars/*.fields',
        'encoding': 'big-endian IEEE-754 f32 hex bits, written by engine/harness/t005d-vehicle/car_xt.py',
        'cars': cars,
    }


def anchors() -> dict:
    def grab(path: Path, pattern: str):
        text = path.read_text(encoding='utf-8')
        match = re.search(pattern, text)
        if not match:
            raise SystemExit('anchor not found: ' + pattern)
        line = text.count('\n', 0, match.start()) + 1
        start = text.rfind('\n', 0, match.start()) + 1
        end = text.find('\n', match.end())
        return {
            'source': str(path.relative_to(ROOT)).replace('\\', '/'),
            'line': line,
            'text': text[start:end].strip(),
        }

    return {
        'steerCurve': grab(CAR_CPP, r'float steer = Controls\(\)\.steer \* Abs\(Controls\(\)\.steer\);'),
        'steerSmooth': grab(CAR_CPP, r'm_dd\.steer = m_dd\.steer \* f \+ steer \* \(1\.f - f\);'),
        'throttleSmooth': grab(CAR_CPP, r'm_dd\.throttle = m_dd\.throttle \* f \+ throttle \* \(1\.f - f\);'),
        'brakeSmooth': grab(CAR_CPP, r'm_dd\.brake = m_dd\.brake \* f \+ brake \* \(1\.f - f\);'),
        'handbrakeSmooth': grab(CAR_CPP, r'm_dd\.handbrake = m_dd\.handbrake \* f \+ Controls\(\)\.handbrake \* \(1\.f - f\);'),
        'handbrakeThreshold': grab(RLC, r'm_bHandbrake\s*=.*> 0\.5f'),
        'steerRead': grab(RLC, r'float steering=Maths::Clamp\(Input::GetGameInput'),
        'changeViewDebounced': grab(VEHICLE_FEED, r'GetButtonPressedDebounced\(Game::E_Button_ChangeView\)'),
        'rearView': grab(VEHICLE_FEED, r'm_LookY = -1\.f;'),
        'changeCameraCount': grab(ROOT / 'upstream/BlurRebuilt/code/amax/game/Game/AmaxCam/VFCamera.h',
                                  r'E_VFCamera_Hollywood = 0'),
        'cameraBlend': grab(VEHICLE_FEED, r'F32 blendTime = 0\.5f;'),
        'tractionControl': grab(CAR_CPP, r'FloatVR maxSlip = Dynamics\(\)\.engine\.tractionControlMaxSlip;'),
        'deadzoneFormula': grab(INPUT_CPP, r'F32 newLen = \(len - deadzone\) / \(1\.0f - deadzone\);'),
        'steerAssistCommented': grab(GAME_PROFILE_H, r'//U8 mSteeringAssist;'),
    }


def main() -> None:
    decoded, ui_source = read_ui_bin()
    ui = decode_ui(decoded)
    loc = resolve_loc_names([item['locId'] for item in ui['configs']])
    for item in ui['configs']:
        item['name'] = loc.get(item['locId'], None)
    controls = parse_game_controls()
    layouts = build_layouts(controls)
    data = {
        'schema': 'blur.retail-input',
        'version': 1,
        'ui': {'source': ui_source, **ui},
        'keyboard': {
            'source': controls['source'],
            'buttonsLine': controls['buttonsLine'],
            'buttonsSplitLine': controls['buttonsSplitLine'],
            'axesLine': controls['axesLine'],
            'axesSplitLine': controls['axesSplitLine'],
            'normalActions': controls['normalActions'],
            'normalAxes': controls['normalAxes'],
            'layouts': layouts,
            'splitScreen': controls['splitScreen'],
        },
        'padDeadzone': parse_deadzone(),
        'carInputParams': parse_car_params(),
        'anchors': anchors(),
        'notes': [
            'Keyboard layouts are parsed from the recovered retail source tables (GameControls.cpp); they are not stored in an XT.',
            'Pad ControlConfigs are decoded from gamedata.pak \\gamedata\\xt\\ui.bin (FLSK v2), UiXtConfig record 95.',
            'Pad stick axes are not in C_ControlConfig; steering/pitch/look axes are hardwired in SetupAmaxUserControlsPC.',
            'Steering assist / braking assist option fields are commented out in ProfileOptions (GameProfile.h); they are absent, not zero.',
        ],
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, indent=2), encoding='utf-8')
    print(json.dumps({
        'out': str(OUT.relative_to(ROOT)).replace('\\', '/'),
        'uiSha256': ui_source['decodedSha256'],
        'configs': [(c['index'], c['locId'], c.get('name'), c['actions']) for c in ui['configs']],
        'deadzone': data['padDeadzone']['value'],
        'cars': len(data['carInputParams']['cars']),
        'anchors': len(data['anchors']),
    }, indent=2))


if __name__ == '__main__':
    main()
