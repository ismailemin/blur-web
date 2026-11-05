"""Build the RPM -> engine-loop model from the retail Race_V8_engine .dat.

Evidence chain:
  * gamedata/xt/AudioEntities.bin and gamedata/xt/Audio.bin name the object graph;
  * root.pak:\\audio\\race_v8_engine.dat is the AOBJ graph (Definition.cpp format);
  * each EngineNVolume/EngineNPitch is a PiecewiseLinearFunction whose control
    input is component 1, the "RPMInput" ControlInput;
  * BaseMessageHandler.cpp sets DynamicsRPM = Engine().RPM() * 0.0001;
  * therefore PLF x is RPM/10000, and the pitch curve's 2.0 endpoint gives
    playbackRate = RPM / rpmLabel exactly.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import inspect_dat as xt  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dat", type=Path, default=ROOT / "_work/audio/race_v8_engine.dat")
    parser.add_argument("--wav-dir", type=Path, default=ROOT / "_work/audio")
    parser.add_argument("--out", type=Path, default=ROOT / "_work/audio/engine-model.json")
    args = parser.parse_args()

    data = args.dat.read_bytes()
    obj = xt.Object(data)
    by_name = {c["name"]: c for c in obj.components}
    curves = {}
    for c in obj.components:
        curve = obj.read_curve(c["index"])
        if curve:
            curves[curve["name"]] = curve
    sounds = {}
    for c in obj.components:
        info = obj.sound_info(c["index"])
        if info:
            sounds[info["name"]] = info

    loops = []
    for slot in range(1, 8):
        vol_name = f"Engine{slot}Volume"
        pitch_name = f"Engine{slot}Pitch"
        sound_name = f"Engine{slot}Sound"
        if vol_name not in curves or pitch_name not in curves or sound_name not in sounds:
            continue
        wave = sounds[sound_name]["wave"]
        match = re.search(r"_(\d+)$", wave)
        label = int(match.group(1)) if match else None
        loops.append({
            "slot": slot,
            "sound": sound_name,
            "bank": sounds[sound_name]["bank"],
            "wave": wave,
            "rpmLabel": label,
            "volume": curves[vol_name]["points"],
            "pitch": curves[pitch_name]["points"],
        })

    # The first Control after strName (offset +4) is Com(2), Out(2); component 1
    # is the RPMInput ControlInput, which proves the curve domain.
    for loop in loops:
        c = by_name[f"Engine{loop['slot']}Volume"]
        com = xt.i16(data, c["dataOffset"] + 4)
        target = obj.components[com] if 0 <= com < len(obj.components) else None
        loop["volumeCtrlCom"] = com
        loop["volumeCtrlComponent"] = target["name"] if target else f"component {com}"
        loop["volumeCtrlType"] = target["typeName"] if target else None

    model = {
        "object": obj.name,
        "dat": "root.pak:\\audio\\race_v8_engine.dat",
        "datBytes": len(data),
        "datSha256": hashlib.sha256(data).hexdigest(),
        "format": {"magic": "AOBJ", "version": f"{obj.version >> 16}.{obj.version & 0xffff}"},
        "header": {
            "declaredComponents": obj.num_components,
            "parsedComponents": len(obj.components),
            "stringTableOffset": obj.string_offset,
            "endOffset": obj.end_offset,
            "walkError": obj.walk_error,
        },
        "rpmParameter": {
            "name": "RPMInput",
            "componentIndex": by_name.get("RPMInput", {}).get("index"),
            "domain": "x = Engine().RPM() * 0.0001",
            "source": [
                "code/amax/game/Game/GameActors/Components/AudioMessageHandlers/BaseMessageHandler.cpp:1940",
                "code/amax/game/Game/GameActors/Components/AudioMessageHandlers/BaseMessageHandler.cpp:1970",
            ],
        },
        "loops": loops,
        "unusedBankWaves": {
            "RaceV8_Engine_720": "present in race_v8.baf; no Engine0Sound/Engine0Volume component in race_v8_engine.dat",
        },
        "notes": [
            "Engine1..6 cover 1500/1995/3015/4005/4995/6000 RPM; Engine7 is the short decel layer.",
            "Volume and pitch are the exact retail PLF curves; no interpolation law is invented.",
            "The retail graph also multiplies by throttle, damage, induction and camera layers; this model isolates the RPM layer.",
        ],
        "wavFiles": {},
    }
    for loop in loops:
        wav = args.wav_dir / f"{loop['wave']}.wav"
        if wav.exists():
            payload = wav.read_bytes()
            model["wavFiles"][loop["wave"]] = {
                "file": wav.name,
                "bytes": len(payload),
                "sha256": hashlib.sha256(payload).hexdigest(),
            }
    args.out.write_text(json.dumps(model, indent=2) + "\n", encoding="utf-8")

    print(f"object {obj.name} declared={obj.num_components} parsed={len(obj.components)} "
          f"walkError={obj.walk_error}")
    for loop in loops:
        print(f"  slot {loop['slot']} {loop['wave']:22s} rpm={loop['rpmLabel']} "
              f"ctrl={loop['volumeCtrlCom']}:{loop['volumeCtrlComponent']} "
              f"vol={loop['volume']} pitch={loop['pitch']}")
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
