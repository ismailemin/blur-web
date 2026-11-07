"""Build the tyre/collision audio model from retail banks and AOBJ graphs.

Reads only `_work/audio` copies produced by extract_baf.py / extract_dat.py.
Emits `_work/audio/tyre-collision-model.json` and a script disassembly log.

Component Data layouts and the Script opcodes are read from upstream source:
  code/mercury/library/audio/source/components/*.h
  code/mercury/library/audio/source/components/Script.cpp
  code/mercury/library/audio/source/components/Selector.cpp
  code/mercury/library/audio/source/Definition.cpp
  code/amax/game/Game/GameDef/Materials.h
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import inspect_dat as xt  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]

# Banks decoded for this slice. Every name is a retail root.pak:\audio\*.baf.
BANKS = [
    "wheel_dry",
    "wheel_offroad",
    "wheel_common",
    "car_collisions",
    "do_metal_vehicle_car",
    "do_concrete_fence_chain",
    "do_concrete_fence_plastic",
    "do_concrete_large",
    "do_glass_hit",
    "do_metal_armco",
    "do_metal_fence_chainlink",
    "do_metal_hollow_large",
    "do_metal_post_tall",
    "do_metal_railing",
    "do_metal_sheet",
    "do_metal_solid_medium",
    "do_rubber_tyre",
    "do_vegetation_hedge",
    "do_wood_fence",
]

# Graphs decoded for the tyre + collision slice.
GRAPHS = [
    "wheel_controller",
    "wheel_dry",
    "wheel_offroad",
    "wheel_common",
    "collisionworld",
    "collisioncar",
    "collisionscrape",
    "do_metal_vehicle_car",
    "do_concrete_fence_plastic",
    "do_concrete_large",
    "do_glass_hit",
    "do_metal_armco",
    "do_metal_fence_chainlink",
    "do_metal_hollow_large",
    "do_metal_post_tall",
    "do_metal_railing",
    "do_metal_sheet",
    "do_metal_solid_medium",
    "do_rubber_tyre",
    "do_vegetation_hedge",
    "do_wood_fence",
]

# Script opcodes (Script.cpp:34-69).
OPCODES = {
    0x0000: "OpBreak",
    0x1000: "OpSend",
    0x1001: "OpPush",
    0x1002: "OpPull",
    0x1003: "OpDiscard",
    0x1004: "OpPushFloat",
    0x1100: "OpJump",
    0x1101: "OpJumpEqual",
    0x1102: "OpJumpNotEqual",
    0x1103: "OpJumpLessThan",
    0x1104: "OpJumpNotLessThan",
    0x1105: "OpJumpGreaterThan",
    0x1106: "OpJumpNotGreaterThan",
    0x1300: "OpCompare",
    0x1301: "OpAdd",
    0x1302: "OpSubtract",
    0x1303: "OpMultiply",
    0x1304: "OpDivide",
    0x1305: "OpAddFloat",
    0x1306: "OpSubtractFloat",
    0x1307: "OpMultiplyFloat",
    0x1308: "OpDivideFloat",
    0x1310: "OpSetEqual",
    0x1311: "OpSetLessThan",
    0x1312: "OpSetGreaterThan",
    0x1314: "OpClearEqual",
    0x1315: "OpClearLessThan",
    0x1316: "OpClearGreaterThan",
    0x1317: "OpCompareParams",
    0x1200: "OpExecute",
    0x1201: "OpCall",
    0x1202: "OpExit",
    0x1203: "OpDestruct",
}


def u16(d: bytes, o: int) -> int:
    return struct.unpack_from("<H", d, o)[0]


def i16(d: bytes, o: int) -> int:
    return struct.unpack_from("<h", d, o)[0]


def u32(d: bytes, o: int) -> int:
    return struct.unpack_from("<I", d, o)[0]


def f32(d: bytes, o: int) -> float:
    return struct.unpack_from("<f", d, o)[0]


def read_option(d: bytes, base: int) -> dict:
    """Option { Control ctrl; AudioFloat fVal; } (32-bit build)."""
    return {
        "sCom": i16(d, base),
        "uOut": u16(d, base + 2),
        "fVal": f32(d, base + 4),
    }


def read_curve(obj: xt.Object, comp: dict) -> dict | None:
    base = comp["dataOffset"]
    n = u16(obj.data, base + 16)
    points = []
    off = base + 20
    for _ in range(n):
        points.append([f32(obj.data, off), f32(obj.data, off + 8)])
        off += 12
    return {
        "name": comp["name"],
        "control": {"sCom": i16(obj.data, base + 4), "uOut": u16(obj.data, base + 6)},
        "option": read_option(obj.data, base + 8),
        "points": points,
    }


def read_array(obj: xt.Object, comp: dict) -> dict:
    base = comp["dataOffset"]
    n = u16(obj.data, base + 16)
    elements = []
    for i in range(n):
        elements.append(read_option(obj.data, base + 20 + i * 8))
    return {
        "name": comp["name"],
        "control": {"sCom": i16(obj.data, base + 4), "uOut": u16(obj.data, base + 6)},
        "offset": read_option(obj.data, base + 8),
        "elements": elements,
    }


def read_selector(obj: xt.Object, comp: dict) -> dict:
    base = comp["dataOffset"]
    n = u16(obj.data, base + 12)
    elements = []
    for i in range(n):
        e = base + 16 + i * 32
        elements.append({
            "element": read_option(obj.data, e),
            "weight": read_option(obj.data, e + 8),
            "scale": read_option(obj.data, e + 16),
            "offset": read_option(obj.data, e + 24),
        })
    return {
        "name": comp["name"],
        "reset": read_option(obj.data, base + 4),
        "elements": elements,
    }


def read_sound(obj: xt.Object, comp: dict) -> dict:
    base = comp["dataOffset"]
    ctype = comp["type"]

    def text(off: int) -> str:
        return obj.string(u32(obj.data, off))

    info = {"name": comp["name"], "type": comp["typeName"]}
    if ctype == 59:  # MonoOneShotSound
        info.update({
            "bank": text(base + 4), "wave": text(base + 8),
            "pitch": read_option(obj.data, base + 12),
            "frequency": read_option(obj.data, base + 20),
            "gain": read_option(obj.data, base + 28),
            "level": read_option(obj.data, base + 36),
        })
    elif ctype == 61:  # MonoOneShotSoundTable
        waves = []
        for i in range(u16(obj.data, base + 56)):
            waves.append(obj.string(u32(obj.data, base + 60 + i * 4)))
        info.update({
            "bank": text(base + 4), "waves": waves,
            "index": read_option(obj.data, base + 8),
            "pitch": read_option(obj.data, base + 16),
            "frequency": read_option(obj.data, base + 24),
            "gain": read_option(obj.data, base + 32),
            "level": read_option(obj.data, base + 40),
            "instances": u16(obj.data, base + 54),
        })
    elif ctype == 63:  # MonoLoopingSound
        info.update({
            "bank": text(base + 4), "wave": text(base + 8),
            "pitch": read_option(obj.data, base + 12),
            "frequency": read_option(obj.data, base + 20),
            "gain": read_option(obj.data, base + 28),
            "level": read_option(obj.data, base + 36),
            "offset": read_option(obj.data, base + 44),
        })
    return info


def read_script(obj: xt.Object, comp: dict) -> dict:
    base = comp["dataOffset"]
    length = u16(obj.data, base + 4)
    code = [u32(obj.data, base + 8 + i * 4) for i in range(length)]
    return {"name": comp["name"], "length": length, "words": code}


def component_name(obj: xt.Object, index: int) -> str | None:
    if 0 <= index < len(obj.components):
        return obj.components[index]["name"]
    return None


def instruction_sends(obj: xt.Object, code: list[int]) -> dict[int, tuple[int, int]]:
    """Map word index -> (component, message) for every OpSend in a script."""
    sends: dict[int, tuple[int, int]] = {}
    pc = 0
    while pc < len(code):
        start = pc
        op = code[pc]
        pc += 1
        if op == 0x1000:  # OpSend
            word = code[pc]
            pc += 1
            msg = code[pc]
            pc += 1
            sends[start] = (word >> 16, msg)
        elif op in (0x1001, 0x1002, 0x1200, 0x1301, 0x1302, 0x1303, 0x1304):
            pc += 1
        elif op == 0x1317:  # OpCompareParams: component word + float word
            pc += 2
        elif op in (0x1004, 0x1305, 0x1306, 0x1307, 0x1308):
            pc += 1
        elif 0x1100 <= op <= 0x1106:
            pc += 1
        elif op in (0x1201, 0x1202, 0x1203, 0x1310, 0x1311, 0x1312, 0x1314,
                    0x1315, 0x1316, 0x1300, 0x1003, 0x0000):
            continue
        else:
            # Unknown length: stop rather than desynchronise.
            break
    return sends


def derive_collision_routing(obj: xt.Object, script: dict) -> list[dict]:
    """Decode `CompareParams CollisionSurfaceType` + `JumpEqual` + `Send`.

    This is the exact shape used by CollisionWorld's CollisionScript. The parser
    only records pairs whose compare target is component 0 (CollisionSurfaceType)
    and whose taken branch is an OpSend; anything else is left alone.
    """
    code = script["words"]
    sends = instruction_sends(obj, code)
    routing = []
    for pc in range(0, len(code) - 4):
        if code[pc] != 0x1317 or (code[pc + 1] >> 16) != 0:
            continue
        if code[pc + 3] != 0x1101:
            continue
        value = struct.unpack("<f", struct.pack("<I", code[pc + 2]))[0]
        target = code[pc + 4]
        send = sends.get(target)
        if not send:
            continue
        com, msg = send
        routing.append({
            "surfaceValue": value,
            "targetComponent": com,
            "targetName": component_name(obj, com),
            "message": msg,
        })
    return routing


def disassemble(obj: xt.Object, script: dict) -> list[str]:
    code = script["words"]
    lines: list[str] = []
    pc = 0
    while pc < len(code):
        start = pc
        op = code[pc]
        pc += 1
        name = OPCODES.get(op, f"0x{op:04x}?")
        if op == 0x1000:  # Send
            word = code[pc]; pc += 1
            com = word >> 16
            msg = code[pc]; pc += 1
            lines.append(f"{start:4d} {name:22s} com={com}({component_name(obj, com)}) msg={msg}")
        elif op in (0x1001, 0x1301, 0x1302, 0x1303, 0x1304, 0x1317):  # Push/arith ref
            word = code[pc]; pc += 1
            com, out = word >> 16, word & 0xFFFF
            lines.append(f"{start:4d} {name:22s} com={com}({component_name(obj, com)}) out={out}")
        elif op == 0x1004:  # PushFloat
            word = code[pc]; pc += 1
            lines.append(f"{start:4d} {name:22s} {struct.unpack('<f', struct.pack('<I', word))[0]:.6g}")
        elif op in (0x1305, 0x1306, 0x1307, 0x1308):  # float arith
            word = code[pc]; pc += 1
            lines.append(f"{start:4d} {name:22s} {struct.unpack('<f', struct.pack('<I', word))[0]:.6g}")
        elif op == 0x1002:  # Pull
            word = code[pc]; pc += 1
            com = word >> 16
            lines.append(f"{start:4d} {name:22s} com={com}({component_name(obj, com)})")
        elif op == 0x1200:  # Execute
            word = code[pc]; pc += 1
            com = word >> 16
            lines.append(f"{start:4d} {name:22s} com={com}({component_name(obj, com)})")
        elif 0x1100 <= op <= 0x1106:  # jumps
            target = code[pc]; pc += 1
            lines.append(f"{start:4d} {name:22s} -> {target}")
        else:
            lines.append(f"{start:4d} {name}")
    return lines


def parse_effect_materials() -> list[dict]:
    header = (ROOT / "upstream/BlurRebuilt/code/amax/game/Game/GameDef/Materials.h")
    text = header.read_text(encoding="utf-8", errors="replace")
    start = text.index("enum E_EffectMaterial")
    end = text.index("};", start)
    names: list[str] = []
    for line in text[start:end].splitlines():
        line = line.split("//")[0].strip().rstrip(",")
        match = re.match(r"(E_EffectMaterial_[A-Za-z0-9_]+)\s*(?:=\s*(\d+))?$", line)
        if not match:
            continue
        if match.group(2) is not None:
            index = int(match.group(2))
            while len(names) < index:
                names.append(f"<unused {len(names)}>")
            name = match.group(1)
            if len(names) == index:
                names.append(name)
            else:
                names[index] = name
        else:
            names.append(match.group(1))
    return [{"index": i, "name": n} for i, n in enumerate(names)]


def bank_report(name: str) -> dict:
    path = ROOT / f"_work/audio/{name}.baf.json"
    if not path.exists():
        raise SystemExit(f"missing bank report {path}; run extract_baf.py first")
    data = json.loads(path.read_text(encoding="utf-8"))
    waves = []
    for wave in data["waves"]:
        meta = wave.get("adpcm", {})
        waves.append({
            "index": wave["index"],
            "name": wave["name"],
            "format": wave["format"],
            "sampleRate": meta.get("sampleRate"),
            "samples": meta.get("samples"),
            "channels": meta.get("channels"),
            "loop": bool(meta.get("loop")),
            "bitsPerSample": meta.get("bitsPerSample"),
            "dataStart": wave["dataStart"],
            "dataLength": wave["dataLength"],
        })
    outputs = {o["wave"]: o for o in data.get("outputs", [])}
    for wave in waves:
        out = outputs.get(wave["name"])
        if out:
            wave.update({
                "wav": out["wav"],
                "wavBytes": out["bytes"],
                "wavSha256": out["sha256"],
                "durationSeconds": out["durationSeconds"],
                "peak": out["peak"],
                "rms": out["rms"],
            })
    return {
        "pak": data["pak"],
        "asset": data["asset"]["path"],
        "storedBytes": data["asset"]["stored_bytes"],
        "logicalBytes": data["asset"]["logical_bytes"],
        "bankName": data["bankName"],
        "version": data["version"],
        "bankSha256": data["bankSha256"],
        "waveCount": data["waveCount"],
        "waves": waves,
    }


def graph_model(name: str) -> dict:
    path = ROOT / f"_work/audio/{name}.dat"
    if not path.exists():
        raise SystemExit(f"missing graph {path}; run extract_dat.py first")
    data = path.read_bytes()
    obj = xt.Object(data)
    curves = []
    arrays = []
    selectors = []
    sounds = []
    scripts = []
    params = []
    controls = []
    for comp in obj.components:
        t = comp["type"]
        if t == 0:
            params.append({"name": comp["name"], "default": f32(data, comp["dataOffset"] + 4)})
        elif t == 6:
            controls.append({"name": comp["name"]})
        elif t in (21, 57):
            curve = read_curve(obj, comp)
            if curve:
                curves.append(curve)
        elif t == 55:
            arrays.append(read_array(obj, comp))
        elif t == 33:
            selectors.append(read_selector(obj, comp))
        elif t in (59, 61, 63):
            sounds.append(read_sound(obj, comp))
        elif t == 189:
            scripts.append(read_script(obj, comp))
    collision_routing = []
    if obj.name == "CollisionWorld":
        collision_script = next((s for s in scripts if s["name"] == "CollisionScript"), None)
        if collision_script:
            collision_routing = derive_collision_routing(obj, collision_script)
    return {
        "dat": f"root.pak:\\audio\\dat\\{name}.dat",
        "bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "object": obj.name,
        "version": f"{obj.version >> 16}.{obj.version & 0xffff}",
        "declaredComponents": obj.num_components,
        "parsedComponents": len(obj.components),
        "walkError": obj.walk_error,
        "parameters": params,
        "controls": controls,
        "curves": curves,
        "arrays": arrays,
        "selectors": selectors,
        "sounds": sounds,
        "scripts": scripts,
        "collisionRouting": collision_routing,
        "_obj": obj,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=ROOT / "_work/audio/tyre-collision-model.json")
    parser.add_argument("--scripts", type=Path, default=ROOT / "_work/logs/audio/script-disassembly.txt")
    args = parser.parse_args()

    model = {
        "generatedBy": "probes/audio/dump_tyre_collision.py",
        "note": "Decoded retail data only; no fitted or invented values.",
        "effectMaterials": parse_effect_materials(),
        "banks": {},
        "graphs": {},
    }
    for bank in BANKS:
        model["banks"][bank] = bank_report(bank)
    for graph in GRAPHS:
        model["graphs"][graph] = graph_model(graph)

    lines = []
    for graph in GRAPHS:
        entry = model["graphs"][graph]
        obj: xt.Object = entry["_obj"]
        lines.append(f"===== {entry['dat']} object={entry['object']} =====")
        for script in entry["scripts"]:
            lines.append(f"-- {script['name']} ({script['length']} words)")
            lines.extend(disassemble(obj, script))
        lines.append("")
    args.scripts.parent.mkdir(parents=True, exist_ok=True)
    args.scripts.write_text("\n".join(lines) + "\n", encoding="utf-8")

    for entry in model["graphs"].values():
        entry.pop("_obj", None)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(model, indent=2) + "\n", encoding="utf-8")

    print(f"wrote {args.out} ({args.out.stat().st_size} bytes)")
    print(f"wrote {args.scripts} ({args.scripts.stat().st_size} bytes)")
    for bank, entry in model["banks"].items():
        decoded = sum(1 for w in entry["waves"] if w.get("wavSha256"))
        print(f"bank {bank:24s} waves={entry['waveCount']:3d} decoded={decoded:3d} sha={entry['bankSha256'][:16]}")
    for graph, entry in model["graphs"].items():
        print(f"graph {graph:24s} components={entry['parsedComponents']:3d}/{entry['declaredComponents']:3d} "
              f"curves={len(entry['curves']):2d} sounds={len(entry['sounds']):2d} scripts={len(entry['scripts'])} "
              f"walkError={entry['walkError']}")


if __name__ == "__main__":
    main()
