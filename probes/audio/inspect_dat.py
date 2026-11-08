"""Inspect an Ovis audio object (.dat) using the upstream component layout.

The container header and component walk are taken from
code/mercury/library/audio/source/Definition.cpp and Object.cpp.
Component Data structs/DataSize rules come from
code/mercury/library/audio/source/components/*.h.

This decoder is intentionally bounded: if a component type has no implemented
size rule it stops and reports the byte offset instead of guessing.
"""
from __future__ import annotations

import argparse
import json
import struct
from pathlib import Path

# Component::Types order is read from components/Component.h so the table cannot
# drift from the source.  Fallback covers the entry points used by the probe.
COMPONENT_HEADER = (
    Path(__file__).resolve().parents[2]
    / "upstream/BlurRebuilt/code/mercury/library/audio/source/components/Component.h"
)
FALLBACK = {
    0: "eParameterIn", 6: "eControlInput", 8: "eEventInput", 10: "eCoordinateInput",
    15: "eStereoAudioOutput", 21: "ePiecewiseLinearFunction", 28: "eTimer",
    37: "eProduct", 44: "eGradient", 52: "eEnvelope", 55: "eArray",
    57: "ePiecewiseLinearGraph", 63: "eMonoLoopingSound", 64: "eStereoLoopingSound",
    189: "eScript",
}


def load_component_names() -> dict[int, str]:
    if not COMPONENT_HEADER.exists():
        return dict(FALLBACK)
    import re

    text = COMPONENT_HEADER.read_text(encoding="utf-8", errors="replace")
    start = text.index("enum Types")
    end = text.index("NumComponents", start)
    names: list[str] = []
    for line in text[start:end].splitlines():
        line = line.split("//")[0]
        names.extend(re.findall(r"\b(e[A-Za-z0-9_]+)\b", line))
    names = [n for n in names if n not in ("enum", "eUndefined")]
    return {i: n for i, n in enumerate(names)}


NAMES = load_component_names()


def u32(d: bytes, o: int) -> int:
    return struct.unpack_from("<I", d, o)[0]


def i32(d: bytes, o: int) -> int:
    return struct.unpack_from("<i", d, o)[0]


def f32(d: bytes, o: int) -> float:
    return struct.unpack_from("<f", d, o)[0]


def u16(d: bytes, o: int) -> int:
    return struct.unpack_from("<H", d, o)[0]


def i16(d: bytes, o: int) -> int:
    return struct.unpack_from("<h", d, o)[0]


class Object:
    def __init__(self, data: bytes):
        if len(data) < 24 or u32(data, 0) != 0x414F424A:  # 'AOBJ'
            raise ValueError("not an AOBJ dat")
        self.data = data
        self.version = u32(data, 4)
        self.string_offset = u32(data, 8)
        self.name_offset = u32(data, 12)
        self.num_components = u32(data, 16)
        self.frame_skip = u32(data, 20)
        self.strings = data[self.string_offset:]
        self.name = self.string(self.name_offset)
        self.components = []
        self._walk()

    def string(self, offset: int) -> str:
        if offset < 0 or offset >= len(self.strings):
            return f"<bad string {offset}>"
        end = self.strings.find(b"\x00", offset)
        if end < 0:
            return f"<unterminated {offset}>"
        return self.strings[offset:end].decode("latin-1")

    def _walk(self) -> None:
        off = 24
        self.walk_error = None
        self.end_offset = off
        for index in range(self.num_components):
            if off + 4 > len(self.data):
                self.walk_error = f"component {index} outside file at 0x{off:x}"
                break
            ctype = u32(self.data, off)
            data = off + 4
            try:
                size = self.data_size(ctype, data)
            except NotImplementedError as exc:
                self.walk_error = (
                    f"component {index} type {ctype} ({NAMES.get(ctype)}) at 0x{off:x}: {exc}"
                )
                break
            self.components.append({
                "index": index, "type": ctype, "typeName": NAMES.get(ctype, "?"),
                "offset": off, "dataOffset": data, "dataBytes": size,
                "name": self.string(i32(self.data, data)) if size >= 4 else "",
            })
            off = data + size
            self.end_offset = off
        if self.walk_error is None:
            self.end_offset = off
        self.end_offset = off

    def data_size(self, ctype: int, data: int) -> int:
        d = self.data
        if ctype == 0:  # ParameterIn: name + float default
            return 8
        if ctype == 1:  # ParameterOut: name + option
            return 12
        if ctype == 2:  # ActionIn: name + event
            return 8
        if ctype == 3:  # ActionOut: name
            return 4
        if ctype == 4:  # VectorIn: name + X/Y/Z AudioFloat
            return 16
        if ctype == 5:  # VectorOut: name + 3 x (S32, U32, F32)
            return 40
        if ctype in (9, 10, 12, 14, 16, 18):  # event/coord/audio inputs: name only
            return 4
        if ctype in (13, 15, 17, 19):  # audio outputs: name + input connector
            return 8
        if ctype == 7:  # ControlOutput (AUDIO_NEW_OUTPUT_OUTPUTS): name + Option
            return 12
        if ctype == 11:  # CoordinateOutput: name + Com input
            return 8
        if ctype == 6:  # ControlInput
            return 4
        if ctype == 8:  # EventInput
            return 8
        if ctype == 10:  # CoordinateInput
            return 4
        if ctype == 12:  # MonoAudioInput
            return 4
        if ctype == 14:  # StereoAudioInput
            return 4
        if ctype == 15:  # StereoAudioOutput
            return 8
        if ctype == 16:  # SurroundAudioInput
            return 4
        if ctype == 17:  # SurroundAudioOutput
            return 8
        if ctype == 28:  # Timer: name + 3 options + event
            return 4 + 3 * 8 + 4
        if ctype == 37:  # Product: name + uNumInputs + inputs
            return 8 + u16(d, data + 4) * 8
        if ctype in (36, 41, 42):  # Sum/Max/Min: name + uNumInputs + inputs
            return 8 + u16(d, data + 4) * 8
        if ctype == 40:  # Exponent: name + Control input + Option power
            return 16
        if ctype == 44:  # Gradient: name + Control input
            return 8
        if ctype in (26, 27):  # LowPass/HighPass: name + Control input + Option cutoff
            return 16
        if ctype == 21:  # PiecewiseLinearFunction: name, control, option, count
            return 20 + u16(d, data + 16) * 12
        if ctype == 57:  # PiecewiseLinearGraph
            return 20 + u16(d, data + 16) * 12
        if ctype == 22:  # PiecewiseCubicFunction
            return 20 + u16(d, data + 16) * 12
        if ctype == 55:  # Array: name, control, option, count
            return 20 + u16(d, data + 16) * 8
        if ctype == 33:  # Selector: name, reset option, count
            return 16 + u16(d, data + 12) * 32
        if ctype == 59:  # MonoOneShotSound
            return 52 + u16(d, data + 48) * 4
        if ctype == 60:  # StereoOneShotSound
            return 52 + u16(d, data + 48) * 4
        if ctype == 61:  # MonoOneShotSoundTable: Data=60, then InputWave[uWaves], U32[uEffects]
            return 60 + u16(d, data + 56) * 4 + u16(d, data + 52) * 4
        if ctype == 62:  # StereoOneShotSoundTable (same DataSize rule as mono)
            return 60 + u16(d, data + 56) * 4 + u16(d, data + 52) * 4
        if ctype == 63:  # MonoLoopingSound
            return 60 + u16(d, data + 56) * 4
        if ctype == 64:  # StereoLoopingSound
            return 60 + u16(d, data + 56) * 4
        if ctype in (65, 66):  # Mono/StereoStreamingSound (same Data as looping)
            return 60 + u16(d, data + 56) * 4
        if ctype == 20:  # Variable
            return 8
        if ctype == 51:  # SampleAndHold: name + Control input
            return 8
        if ctype == 23:  # Source: name, size option, 33 floats, 11 connectors
            return 168
        if ctype == 24:  # Rolloff: name, control, 5 options
            return 48
        if ctype == 25:  # Cone: name, control, 7 options
            return 64
        if ctype == 43:  # Invert
            return 8
        if ctype == 54:  # GateSwitch: name, control, 4 options, 2 events
            return 48
        if ctype == 30:  # RotarySwitch
            return 12 + u16(d, data + 8) * 8
        if ctype == 31:  # CrossFade
            return 16
        if ctype == 32:  # Random: name + 2 options
            return 20
        if ctype == 52:  # Envelope: name, control, 4 options, 4 events
            return 56
        if ctype == 45:  # Spring: name, control, 2 options
            return 24
        if ctype == 46:  # Cosine
            return 8
        if ctype == 47:  # Sine
            return 8
        if ctype == 34:  # StateMachine
            return 12
        if ctype == 35:  # Quantize
            return 12
        if ctype == 53:  # LowFrequencyOscillator
            return 16
        if ctype == 189:  # eScript: name + word count + code
            return 8 + u16(d, data + 4) * 4
        if ctype in (70, 71):  # mono->surround mixes: name, flags, 6 options, counts
            effects = u16(d, data + 56)
            inputs = u16(d, data + 58)
            return 60 + effects * 4 + inputs * 20
        if 68 <= ctype <= 81:  # other time-domain mixers
            effects = u16(d, data + 20)
            inputs = u16(d, data + 22)
            return 24 + effects * 4 + inputs * 20
        if 142 <= ctype <= 147:  # mono/stereo/surround low/high pass
            return 44
        if 163 <= ctype <= 165:  # peak EQ
            return 60
        if 214 <= ctype <= 216:  # sends: name, 2 options, return connector
            return 24
        if 217 <= ctype <= 219:  # returns: name, 2 options, effect count
            return 24 + u16(d, data + 20) * 4
        if ctype == 199:  # MessageDelay: name, option, event
            return 16
        if ctype == 198:  # ImpactFilter (Component.h:368): name, control, 2 options, event
            return 28
        if ctype == 192:  # DopplerShift: name + Option + 4 Com (DopplerShift.h:12-23)
            return 20
        if ctype == 190:  # eVector: name, 3 options, input vector
            return 32
        raise NotImplementedError("no data-size rule")

    def read_curve(self, index: int) -> dict | None:
        """Decode a PiecewiseLinearFunction/Graph into points (x, y)."""
        c = self.components[index]
        if c["type"] not in (21, 57, 22):
            return None
        base = c["dataOffset"]
        # Data: name, Control input, Option optCurve, ArraySize uNumPoints = 20 bytes
        n = u16(self.data, base + 16)
        points = []
        off = base + 20
        for _ in range(n):
            x = f32(self.data, off)
            y = f32(self.data, off + 8)
            points.append((x, y))
            off += 12
        return {"name": c["name"], "points": points}

    def sound_info(self, index: int) -> dict | None:
        """Decode a Mono/StereoLoopingSound wave reference."""
        c = self.components[index]
        if c["type"] not in (63, 64):
            return None
        base = c["dataOffset"]
        return {
            "name": c["name"],
            "bank": self.string(i32(self.data, base + 4)),
            "wave": self.string(i32(self.data, base + 8)),
        }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dat", type=Path)
    parser.add_argument("--json", type=Path)
    parser.add_argument("--curves", action="store_true", help="print piecewise-linear curves")
    args = parser.parse_args()
    data = args.dat.read_bytes()
    obj = Object(data)
    print(f"object {obj.name!r} version 0x{obj.version:08x} "
          f"components {obj.num_components} parsed {len(obj.components)} "
          f"frameSkip {obj.frame_skip} end 0x{obj.end_offset:x} "
          f"stringTable 0x{obj.string_offset:x} file {len(data):#x}")
    if obj.walk_error:
        print(f"PARTIAL: {obj.walk_error}")
    counts: dict[str, int] = {}
    for c in obj.components:
        counts[c["typeName"]] = counts.get(c["typeName"], 0) + 1
    print("counts:", json.dumps(counts, sort_keys=True))
    for c in obj.components:
        print(f"  {c['index']:3d} {c['type']:3d} {c['typeName']:34s} "
              f"@0x{c['offset']:04x} data={c['dataBytes']:3d} {c['name']}")
    if args.curves:
        print("curves:")
        for c in obj.components:
            curve = obj.read_curve(c["index"])
            if curve:
                pts = ", ".join(f"({x:.6g},{y:.6g})" for x, y in curve["points"])
                print(f"  {curve['name']}: {pts}")
    if args.json:
        args.json.write_text(json.dumps({
            "object": obj.name, "version": obj.version,
            "frameSkip": obj.frame_skip, "endOffset": obj.end_offset,
            "stringTableOffset": obj.string_offset,
            "declaredComponents": obj.num_components,
            "parsedComponents": len(obj.components),
            "walkError": obj.walk_error,
            "components": obj.components,
        }, indent=2) + "\n", encoding="utf-8")
    if obj.walk_error:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
