"""Build the full Blur audio bank / entity / event catalog (read-only).

Inputs (never modified):
  game-data/Blur/cache/root.pak            audio BAF banks + AOBJ graphs
  game-data/Blur/cache/root_streaming.pak  streaming music/env banks
  _work/audio/audioentities.bin            AudioEntityDef pack (FLSK v2)
  _work/audio/audio.bin                    AudioObject / entity group pack

Outputs (all under _work/audio, never committed):
  _work/audio/audio-catalog.json           banks, entities, graphs, events, summary
  _work/audio/audio-manifest.json          decoded/reused waves with hashes + sizes
  _work/audio/integration-contract.json    web consumer contract
  _work/audio/catalog/graphs/*.dat         decoded AOBJ copies (provenance)
  _work/audio/catalog/wav/<bank>/*.wav     newly decoded waves

No value is synthesised or guessed. A wave is either decoded from the retail BAF
or reported as decodable/unsupported with a typed reason.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import struct
import sys
import wave
from collections import Counter, OrderedDict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "probes/audio"))
sys.path.insert(0, str(ROOT / "probes/powerups/tools"))

from inspect_asset_layout import pak_index  # noqa: E402
from extract_baf import (  # noqa: E402
    decode_pak_asset, decode_adpcm, parse_baf, write_wav, BATCH_SAMPLES,
)
import inspect_dat as xt  # noqa: E402
import xt_decode  # noqa: E402

PAKS = ("root.pak", "root_streaming.pak")
GAME = ROOT / "game-data/Blur/cache"
OUT = ROOT / "_work/audio"
CATALOG_DIR = OUT / "catalog"
GRAPH_DIR = CATALOG_DIR / "graphs"
WAV_DIR = CATALOG_DIR / "wav"

CODECS = {7: "uADPCM4Bit", 3: "PCM16"}
SOUND_TYPES = {59, 60, 61, 62, 63, 64, 65, 66}
LOOP_TYPES = {63, 64, 65, 66}
TABLE_TYPES = {61, 62}
CURVE_TYPES = {21, 57, 22}

# Component data-size rules that are needed by the graphs in this catalog but
# were not present in the earlier tyre/collision slice. All are read from the
# upstream component headers, never guessed.
EXTRA_SIZES = {
    168: 40,  # eSurroundCompressor: name + 4 options + ... (checked below)
}


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def read_asset(pak: Path, entry: dict, prefix: int | None = None) -> bytes:
    if prefix is None:
        return decode_pak_asset(pak, entry["logical_bytes"], entry)
    with pak.open("rb") as stream:
        stream.seek(entry["offset"])
        return stream.read(min(prefix, entry["logical_bytes"]))


def parse_bank(data: bytes, logical_bytes: int, full: bool) -> dict:
    """Parse WAVE chunks without requiring the bank to end in DATA chunks.

    Streaming banks (`BankHeader.streaming == 1`) contain only their WAVE
    headers; the sample data lives in an external stream. Non-streaming banks
    carry their DATA inline. Both layouts are recorded explicitly.
    """
    if len(data) < 52:
        raise ValueError("short bank")
    tag, header_size, version, num_waves = struct.unpack_from("<4sIII", data, 0)
    if tag != b"BANK":
        raise ValueError("missing BANK tag")
    endian, streaming = data[16], data[17]
    bank_name = data[18:50].split(b"\x00")[0].decode("latin-1")
    waves: list[dict] = []
    data_chunks: list[dict] = []
    off = 52
    stop = "wave-count"
    while off + 8 <= len(data) and len(waves) < num_waves:
        chunk_tag, chunk_size = struct.unpack_from("<4sI", data, off)
        if chunk_size < 8 or off + chunk_size > len(data):
            stop = f"invalid-chunk-at-{off}"
            break
        if chunk_tag == b"WAVE":
            if chunk_size < 68:
                stop = f"short-WAVE-at-{off}"
                break
            fmt = struct.unpack_from("<I", data, off + 8)[0]
            name = data[off + 12:off + 44].split(b"\x00")[0].decode("latin-1")
            data_start, data_length, level, flags = struct.unpack_from("<IIfI", data, off + 44)
            extra = data[off + 60:off + chunk_size]
            info = {
                "index": len(waves), "name": name, "format": fmt,
                "codec": CODECS.get(fmt, f"unknown-{fmt}"),
                "dataStart": data_start, "dataLength": data_length,
                "defaultLevelDb": level, "flags": flags,
            }
            if fmt == 7:
                size, rate, samples, loop, inter, bps, ch = struct.unpack_from("<IIIBBBB", extra)
                info.update({
                    "sampleRate": rate, "samples": samples, "loop": bool(loop),
                    "interleavedStreams": inter, "bitsPerSample": bps, "channels": ch,
                })
            elif fmt == 3:
                rate, bps, ch, stride, loops = struct.unpack_from("<IIIIB", extra)
                info.update({
                    "sampleRate": rate, "bitsPerSample": bps, "channels": ch,
                    "stride": stride, "loopCount": loops, "loop": bool(loops),
                    "samples": None,
                })
            else:
                info["extraHeaderHex"] = extra.hex()
            info["inBank"] = bool(full and data_start + data_length <= logical_bytes)
            waves.append(info)
        elif chunk_tag == b"DATA":
            data_chunks.append({"offset": off + 8, "bytes": chunk_size - 8})
        off += chunk_size
    else:
        if len(waves) < num_waves:
            stop = "end-of-prefix"
    return {
        "bankName": bank_name, "version": version, "endian": endian,
        "streaming": bool(streaming), "waveCount": num_waves,
        "waves": waves, "dataChunks": len(data_chunks),
        "parseStop": stop, "headerBytesRead": len(data),
    }


def wave_uid(bank: str, index: int, name: str) -> str:
    return f"{bank}:{index}:{name}"


# --------------------------------------------------------------------------- banks
def build_banks() -> tuple[dict, dict, dict]:
    banks: dict[str, dict] = {}
    by_name: dict[str, list[str]] = {}
    summary = {"pakCounts": {}, "codecs": Counter(), "sampleRates": Counter(),
               "channels": Counter(), "loops": 0, "oneShots": 0,
               "waveBytes": 0, "streamingBanks": 0, "banks": 0, "waves": 0}
    for pak_name in PAKS:
        pak = GAME / pak_name
        index = pak_index(pak)
        entries = [e for e in index["entries"] if e["path"].lower().endswith(".baf")]
        summary["pakCounts"][pak_name] = {"banks": len(entries), "codec": index.get("codec")}
        for entry in sorted(entries, key=lambda e: e["path"].lower()):
            full = entry["logical_bytes"] <= 64 * 1024 * 1024
            data = read_asset(pak, entry, None if full else 4 * 1024 * 1024)
            parsed = parse_bank(data, entry["logical_bytes"], full)
            record = {
                "asset": entry["path"], "pak": pak_name,
                "storedBytes": entry["stored_bytes"], "logicalBytes": entry["logical_bytes"],
                "bankSha256": sha256_bytes(data) if full else None,
                "sha256Scope": "full-bank" if full else "header-prefix-not-hashed",
                **parsed,
            }
            key = entry["path"].lower()
            banks[key] = record
            by_name.setdefault(record["bankName"].lower(), []).append(key)
            summary["banks"] += 1
            summary["waves"] += len(record["waves"])
            summary["streamingBanks"] += int(record["streaming"])
            for w in record["waves"]:
                summary["codecs"][w["codec"]] += 1
                summary["sampleRates"][str(w.get("sampleRate"))] += 1
                summary["channels"][str(w.get("channels"))] += 1
                summary["waveBytes"] += w.get("dataLength", 0)
                if w.get("loop"):
                    summary["loops"] += 1
                else:
                    summary["oneShots"] += 1
    summary["codecs"] = dict(summary["codecs"])
    summary["sampleRates"] = dict(summary["sampleRates"])
    summary["channels"] = dict(summary["channels"])
    return banks, by_name, summary


# ------------------------------------------------------------------------- entities
def str_at(strings: bytes, off: int):
    if not (0 <= off < len(strings)):
        return None
    end = strings.find(b"\x00", off)
    return strings[off:end].decode("latin-1") if end >= 0 else None


def array_at(flask, record: int, payload: bytes, off: int):
    comp, elem, count = struct.unpack_from("<2HI", payload, off)
    if comp == 0xFFFF:
        return []
    meta = flask._component_at(record, comp)
    size = flask.types[meta["typeIndex"]][5] if meta["behaviour"] == 0 else 4
    base = flask._component_offset(record, comp) + elem * size
    return [base + k * size for k in range(count)]


def ref_info(flask, index: int):
    if index == 0xFFFFFFFF or index >= len(flask.refs):
        return None
    ref_id, ref_type, ref_record = flask.refs[index]
    return {"refId": ref_id, "typeName": flask.type_name(ref_type),
            "record": None if ref_record == 0xFFFF else ref_record}


def build_entities() -> tuple[list[dict], dict]:
    ent = xt_decode.Flask((OUT / "audioentities.bin").read_bytes())
    aud = xt_decode.Flask((OUT / "audio.bin").read_bytes())
    objects: dict[int, str] = {}
    groups: dict[int, str] = {}
    for i in range(len(aud.records)):
        kind = aud.type_name(aud.record_type(i))
        payload = aud.record_payload(i)
        strings = aud.record_strings(i)
        if kind == "AudioObject":
            objects[aud.record_id(i)] = str_at(strings, struct.unpack_from("<I", payload, 0)[0])
        elif kind == "AudioEntityGroup":
            groups[aud.record_id(i)] = str_at(strings, struct.unpack_from("<I", payload, 0)[0])
    rows = []
    for i in range(len(ent.records)):
        payload = ent.record_payload(i)
        strings = ent.record_strings(i)
        name = str_at(strings, struct.unpack_from("<I", payload, 0)[0])
        group = ref_info(ent, struct.unpack_from("<I", payload, 4)[0])
        objects_out = []
        for at in array_at(ent, i, payload, 8):
            ref = ref_info(ent, struct.unpack_from("<I", payload, at)[0])
            if ref:
                objects_out.append({"refId": ref["refId"], "typeName": ref["typeName"],
                                    "file": objects.get(ref["refId"])})
        instances = []
        for at in array_at(ent, i, payload, 16):
            instances.append(str_at(strings, struct.unpack_from("<I", payload, at)[0]))
        rows.append({
            "record": i, "refId": ent.record_id(i), "name": name,
            "group": groups.get(group["refId"]) if group else None,
            "objects": objects_out, "instances": instances,
        })
    summary = {
        "entities": len(rows),
        "groups": dict(Counter(r["group"] for r in rows)),
        "objects": len(objects),
        "entityGroups": len(groups),
    }
    return rows, summary


# --------------------------------------------------------------------------- graphs
def option_at(obj: xt.Object, data: bytes, base: int) -> dict:
    com = struct.unpack_from("<h", data, base)[0]
    out = struct.unpack_from("<H", data, base + 2)[0]
    value = struct.unpack_from("<f", data, base + 4)[0]
    target = None
    if 0 <= com < len(obj.components):
        c = obj.components[com]
        target = {"index": com, "name": c["name"], "typeName": c["typeName"]}
        if c["type"] in CURVE_TYPES:
            curve = obj.read_curve(com)
            if curve:
                target["curve"] = [[round(x, 9), round(y, 9)] for x, y in curve["points"]]
    return {"sCom": com, "uOut": out, "fVal": round(value, 9),
            "control": target, "literal": com == -1}


def read_sound_full(obj: xt.Object, comp: dict) -> dict:
    data = obj.data
    base = comp["dataOffset"]
    ctype = comp["type"]

    def text(off: int) -> str:
        return obj.string(struct.unpack_from("<i", data, off)[0])

    info = {"name": comp["name"], "type": comp["typeName"], "componentIndex": comp["index"],
            "bank": text(base + 4)}
    if ctype in (59, 60):
        info["waves"] = [text(base + 8)]
        fields = {"pitch": 12, "frequency": 20, "gain": 28, "level": 36}
    elif ctype in (61, 62):
        count = struct.unpack_from("<H", data, base + 56)[0]
        info["waves"] = [text(base + 60 + i * 4) for i in range(count)]
        fields = {"index": 8, "pitch": 16, "frequency": 24, "gain": 32, "level": 40}
    elif ctype in (63, 64, 65, 66):
        info["waves"] = [text(base + 8)]
        fields = {"pitch": 12, "frequency": 20, "gain": 28, "level": 36, "offset": 44}
    else:
        info["waves"] = []
        fields = {}
    info["options"] = {k: option_at(obj, data, base + off) for k, off in fields.items()}
    # Effective literal gain/rate, using Component::GetLevel/GetFrequency:
    #   level is linear, gain is dB, frequency is linear, pitch is octaves.
    opts = info["options"]
    if opts.get("gain", {}).get("literal") and opts.get("level", {}).get("literal"):
        gain_db = opts["gain"]["fVal"]
        gain_lin = opts["level"]["fVal"] * (10.0 ** (gain_db / 20.0) if gain_db else 1.0)
        info["literalGain"] = round(gain_lin, 9)
        info["literalGainDb"] = round(20.0 * math.log10(gain_lin), 9) if gain_lin > 0 else None
    else:
        info["literalGain"] = None
        info["literalGainDb"] = None
    if opts.get("frequency", {}).get("literal") and opts.get("pitch", {}).get("literal"):
        rate = opts["frequency"]["fVal"] * (2.0 ** opts["pitch"]["fVal"] if opts["pitch"]["fVal"] else 1.0)
        info["literalRate"] = round(rate, 9)
    else:
        info["literalRate"] = None
    return info


def parse_graph(path: Path) -> dict:
    data = path.read_bytes()
    obj = xt.Object(data)
    counts = Counter(c["typeName"] for c in obj.components)
    sounds = []
    curves = []
    scripts = []
    for comp in obj.components:
        if comp["type"] in SOUND_TYPES:
            sounds.append(read_sound_full(obj, comp))
        elif comp["type"] in CURVE_TYPES:
            curve = obj.read_curve(comp["index"])
            if curve:
                curves.append({"name": comp["name"], "componentIndex": comp["index"],
                               "points": [[round(x, 9), round(y, 9)] for x, y in curve["points"]]})
        elif comp["type"] == 189:
            length = struct.unpack_from("<H", data, comp["dataOffset"] + 4)[0]
            scripts.append({"name": comp["name"], "words": length})
    return {
        "file": path.name, "object": obj.name,
        "version": f"{obj.version >> 16}.{obj.version & 0xffff}",
        "declaredComponents": obj.num_components, "parsedComponents": len(obj.components),
        "walkError": obj.walk_error, "byteLength": len(data), "sha256": sha256_bytes(data),
        "componentCounts": dict(counts), "sounds": sounds, "curves": curves, "scripts": scripts,
    }


def build_graphs() -> tuple[dict, list[dict]]:
    pak = GAME / "root.pak"
    index = pak_index(pak)
    entries = {e["path"].lower(): e for e in index["entries"]
               if e["path"].lower().startswith("\\audio\\dat\\") and e["path"].lower().endswith(".dat")}
    GRAPH_DIR.mkdir(parents=True, exist_ok=True)
    graphs = {}
    errors = []
    for key, entry in sorted(entries.items()):
        path = GRAPH_DIR / Path(entry["path"]).name.lower()
        data = read_asset(pak, entry)
        path.write_bytes(data)
        try:
            graph = parse_graph(path)
        except Exception as exc:  # bounded parser refused a component
            graph = {"file": path.name, "object": None, "byteLength": len(data),
                     "sha256": sha256_bytes(data), "walkError": f"parse-exception: {exc}",
                     "declaredComponents": None, "parsedComponents": 0,
                     "componentCounts": {}, "sounds": [], "curves": [], "scripts": []}
            errors.append({"file": path.name, "error": str(exc)})
        graphs[path.name.lower()] = graph
    return graphs, errors


# ---------------------------------------------------------------------------- events
def spec(event, category, entity, graph, components, trigger, **extra):
    row = {"event": event, "category": category, "entity": entity,
           "graph": graph, "components": components, "trigger": trigger}
    row.update(extra)
    return row


def event_specs() -> list[dict]:
    rows = []
    # ---- UI (FrontEndUI graph; all names are retail component names) --------
    ui = [
        ("ui.navigate.forward", "FE_ForwardSound", "menu forward / navigation"),
        ("ui.navigate.backward", "FE_BackwardSound", "menu back / navigation"),
        ("ui.confirm", "FE_ChooseSound", "menu confirm (retail reuses the FE_Forward wave)"),
        ("ui.start", "FE_StartSound", "menu start / accept"),
        ("ui.error", "FE_ErrorSound", "invalid action / error"),
        ("ui.toggle", "FE_ToggleSound", "toggle option"),
        ("ui.notice", "FE_NoticeSound", "notice / message"),
        ("ui.carousel.left_right", "FE_Carousel_LRSound", "carousel left/right"),
        ("ui.cascade", "FE_CascadeSound", "cascade transition"),
        ("ui.lrud", "FE_LRUDSound", "list up/down navigation"),
        ("ui.filter", "FE_FilterSound", "filter change"),
        ("ui.tabs.open", "FE_TabsOpenSound", "tab open"),
        ("ui.tabs.close", "FE_TabsCloseSound", "tab close"),
        ("ui.graphic.forward", "FE_GraphicForwardSound", "graphic forward"),
        ("ui.graphic.backward", "FE_GraphicBackwardSound", "graphic backward"),
        ("ui.graphic.power", "FE_GraphicPowerButtonSound", "graphic power button"),
        ("ui.garage.select", "FE_GarageSelectSound", "garage select"),
        ("ui.garage.select_vehicle", "FE_GarageSelectVehicleSound", "garage vehicle select"),
        ("ui.garage.switch_car", "FE_GarageSwitchCarSound", "garage switch car"),
        ("ui.garage.exit", "FE_GarageExitSound", "garage exit"),
        ("ui.garage.respray", "FE_GarageReSpraySound", "garage respray"),
        ("ui.garage.colour_move", "FE_GarageColourPickerMoveSound", "garage colour picker move"),
        ("ui.garage.finish_style.01", "FE_GarageFinishStyleSelect01Sound", "garage finish style 1"),
        ("ui.garage.finish_style.02", "FE_GarageFinishStyleSelect02Sound", "garage finish style 2"),
        ("ui.garage.finish_style.03", "FE_GarageFinishStyleSelect03Sound", "garage finish style 3"),
        ("ui.garage.finish_style.04", "FE_GarageFinishStyleSelect04Sound", "garage finish style 4"),
        ("ui.modshop.attach", "FE_ModShopAttachSound", "mod shop attach"),
        ("ui.modshop.remove", "FE_ModShopRemoveSound", "mod shop remove"),
        ("ui.lobby.join", "FE_LobbyJoinSound", "lobby join"),
        ("ui.lobby.leave", "FE_LobbyLeaveSound", "lobby leave"),
        ("ui.lobby.countdown10", "FE_LobbyCountDown10Sound", "lobby countdown 10"),
        ("ui.lobby.countdown03", "FE_LobbyCountDown03Sound", "lobby countdown 3"),
        ("ui.lobby.vote_count", "FE_LobbyVoteCountSound", "lobby vote count"),
        ("ui.apply_bossmod", "FE_ApplyBossModSound", "apply boss mod"),
        ("ui.boss_demand.increment", "FE_BossDemandIncrementSound", "boss demand increment"),
        ("ui.boss_demand.complete", "FE_BossDemandCompleteSound", "boss demand complete"),
        ("ui.challenge.new_item", "FE_ChallengeNewItemSound", "new challenge item"),
        ("ui.friend.vs", "FE_FriendVsSound", "friend versus screen"),
        ("ui.friend.tale_of_the_tape", "FE_FriendTaleOfTheTapeSound", "friend tale of the tape"),
        ("ui.previously.out", "FE_PreviouslyOutSound", "previously-on outro"),
        ("ui.previously.reward", "FE_PreviouslyRewardSound", "previously-on reward"),
        ("ui.previously.sparks", "FE_PreviouslySparksSound", "previously-on sparks"),
        ("ui.stickers.page", "FE_StickersPageSound", "stickers page"),
        ("ui.unlock_content", "HUD_UnlockContentSound", "content unlocked"),
    ]
    for ev, comp, trigger in ui:
        rows.append(spec(ev, "ui", "FrontEndUI", "FrontEndUI.dat", [comp], trigger))

    # ---- Race / HUD (InGameUI + InGameUIStereo) ----------------------------
    race_mono = [
        ("race.countdown.long", "HUD_CountDownSound", "race countdown 10"),
        ("race.countdown.short", "HUD_CountDown03Sound", "race countdown 3"),
        ("race.start", "HUD_RaceStartSound", "race start"),
        ("race.start.lfe", "HUD_RaceStartLFESound", "race start LFE"),
        ("race.start.countdown", "HUD_RaceStartCountdownSound", "race start countdown"),
        ("race.start.countdown.lfe", "HUD_RaceStartCountdownLFESound", "race start countdown LFE"),
        ("race.perks.countdown", "HUD_PerksCountdownSound", "power-up countdown"),
        ("race.perks.go", "HUD_PerksGoSound", "power-up go"),
        ("race.boss.win", "HUD_BossRaceWinSound", "boss race win"),
        ("race.boss.lose", "HUD_BossRaceLoseSound", "boss race lose"),
        ("race.wreck.destruction", "HUD_DestructionWreckedSound", "destruction mode wreck"),
        ("race.wreck.destruction.long", "HUD_DestructionWreckedLongShotSound", "destruction wreck long shot"),
        ("race.pickup.discard", "HUD_DiscardPickupSound", "discard pickup"),
        ("race.pickup.discard_decoy", "HUD_DiscardDecoyPickupSound", "discard decoy pickup"),
        ("race.pickup.fire_error", "HUD_PickupsFireErrorSound", "pickup fire error"),
        ("race.chain_multiplier", "HUD_ChainMultiplierSound", "chain multiplier"),
        ("race.rank.count", "HUD_RankCountUpSound", "rank count up"),
        ("race.perk.switch", "HUD_PerkSwitchSound", "perk switch"),
        ("race.fans", "HUD_FansSound", "fans"),
        ("race.fans.count_up", "HUD_FansCountUpSound", "fans count up"),
        ("race.fans.demand_fail", "HUD_FanDemandFailSound", "fan demand fail"),
        ("race.fans.demand_success", "HUD_FanDemandSuccessSound", "fan demand success"),
        ("race.fans.gate_pass", "HUD_FanGatePassBeepSound", "fan gate pass"),
        ("race.fans.total_large", "HUD_FansTotalLargeSound", "fans total large"),
        ("race.fans.total_medium", "HUD_FansTotalMediumSound", "fans total medium"),
        ("race.fans.total_small", "HUD_FansTotalSmallSound", "fans total small"),
        ("race.award.light", "HUD_LightAwardSound", "light award"),
        ("race.lock.soft", "HUD_LockSoftSound", "soft lock"),
        ("race.lock.hard", "HUD_LockHardSound", "hard lock"),
        ("race.lock.hard_ecm", "HUD_LockHardECMSound", "hard lock ECM"),
        ("race.mod.use.01", "HUD_ModUse01Sound", "mod use 1"),
        ("race.mod.use.02", "HUD_ModUse02Sound", "mod use 2"),
        ("race.mod.use.03", "HUD_ModUse03Sound", "mod use 3"),
        ("race.mode.mm.count", "HUD_MotorMashCountSound", "motor mash count"),
        ("race.stopwatch", "HUD_StopwatchSound", "stopwatch"),
        ("race.drop_light.status", "HUD_DropLightStatusSound", "drop light status"),
        ("race.postrace.best", "HUD_PostRaceBestSound", "post race best"),
        ("race.postrace.failed", "HUD_PostRaceFailedSound", "post race failed"),
        ("race.postrace.goal_spawn", "HUD_PostRaceGoalSpawnSound", "post race goal spawn"),
        ("race.postrace.leaderboard_spawn", "HUD_PostRaceLeaderboardSpawnSound", "post race leaderboard spawn"),
        ("race.postrace.new_unlocks", "HUD_PostRaceNewUnlocksSound", "post race new unlocks"),
        ("race.postrace.not_best", "HUD_PostRaceNotBestSound", "post race not best"),
        ("race.postrace.passed", "HUD_PostRacePassedSound", "post race passed"),
        ("race.postrace.passed_light_trail", "HUD_PostRacePassedLightTrailSound", "post race passed light trail"),
        ("race.mod.iron_fist", "MOD_IronFistSound", "Iron Fist mod"),
        ("race.mod.scrambler.activate", "MOD_ScramblerActivateSound", "Scrambler activate"),
        ("race.mod.scrambler.deactivate", "MOD_ScramblerDeactivateSound", "Scrambler deactivate"),
    ]
    for ev, comp, trigger in race_mono:
        rows.append(spec(ev, "race", "InGameUI", "InGameUI.dat", [comp], trigger))
    race_stereo = [
        ("race.lap.pass", "HUD_CheckPassSound", "checkpoint / lap pass"),
        ("race.start_line.pass", "HUD_StartLinePassSound", "start line pass"),
        ("race.position.in", "HUD_MPPositionInSound", "position change"),
        ("race.position.first", "HUD_MPPlayerFirstSound", "player first"),
        ("race.position.first.lfe", "HUD_MPPlayerFirstLFESound", "player first LFE"),
        ("race.finish.in", "HUD_MPFinishInSound", "finish in"),
        ("race.finish.in.lfe", "HUD_MPFinishInLFESound", "finish in LFE"),
        ("race.wreck", "HUD_WreckedSound", "wreck"),
        ("race.wreck.lfe", "HUD_WreckedLFESound", "wreck LFE"),
        ("race.health.low", "HUD_HealthLowSound", "health low"),
        ("race.rank.up", "HUD_RankUpSound", "rank up"),
        ("race.challenge.complete", "HUD_ChallengeCompleteSound", "challenge complete"),
        ("race.photo", "HUD_PhotoTakenSound", "photo taken"),
        ("race.gift.health", "HUD_GiftHealthSound", "gift health"),
        ("race.gift.powerup", "HUD_GiftPowerUpSound", "gift power-up"),
        ("race.unlock_content", "HUD_UnlockContentSound", "content unlocked"),
        ("race.mp.final_score", "HUD_MPFinalScoreSound", "MP final score"),
        ("race.mp.rank_away", "HUD_MPRankAwaySound", "MP rank away"),
        ("race.mp.focus_winner", "HUD_MPFocusOnWinnerSound", "MP focus winner"),
        ("race.mp.number_glow", "HUD_MPNumberGlowSound", "MP number glow"),
        ("race.mode.mm.1point", "HUD_MM1PointSound", "motor mash 1 point"),
        ("race.mode.mm.2points", "HUD_MM2PointsSound", "motor mash 2 points"),
        ("race.mode.mm.5points", "HUD_MM5PointsSound", "motor mash 5 points"),
        ("race.zoom.winner.lfe", "HUD_ZoomWinnerLFESound", "zoom winner LFE"),
    ]
    for ev, comp, trigger in race_stereo:
        rows.append(spec(ev, "race", "InGameUI", "InGameUIStereo.dat", [comp], trigger))

    # ---- Power-ups (Pickups bank; graphs are the AudioEntityDef objects) ---
    powerups = [
        ("powerup.pickup", "Pickups", "Pickups.dat", ["PerkPickupSound"], "pickup collected"),
        ("powerup.pickup.loop", "Pickups", "Pickups.dat", ["PickupLoopSound"], "pickup available loop"),
        ("powerup.pickup.decoy_loop", "Pickups", "Pickups.dat", ["PickupDecoyLoopSound"], "decoy pickup loop"),
        ("powerup.pickup.fan_demand", "Pickups", "Pickups.dat", ["FanDemandPickupSound"], "fan-demand pickup"),
        ("powerup.nitro.activate", "NitrousHit", "NitroHit.dat",
         ["NitroFireSound", "NitroFireSweetenerSound", "NitroBackwardFireSound"], "nitro activation"),
        ("powerup.nitro.loop.whine", "NitrousHit", "NitroHit.dat", ["NitroWhineSound"], "nitro whine loop"),
        ("powerup.nitro.loop.flame", "NitrousHit", "NitroHit.dat", ["NitroFlameSound"], "nitro flame loop"),
        ("powerup.nitro.loop.low_boost", "NitrousHit", "NitroHit.dat", ["NitroLowBoostSound"], "nitro low boost loop"),
        ("powerup.nitro.loop.lfe", "NitrousHit", "NitroHit.dat", ["NitroLFESound"], "nitro LFE loop"),
        ("powerup.nitro.impact", "NitrousHit", "NitroHit.dat", ["NitroHitCarSound"], "nitro hits car"),
        ("powerup.shock.activate", "Shock", "ShockFire.dat", ["PickupFireSound"], "shock activation"),
        ("powerup.shock.activate.lfe", "Shock", "ShockFire.dat", ["PickupFireLFESound"], "shock activation LFE"),
        ("powerup.shock.impact", "ShockHit", "ShockHit.dat", ["PickupHitCarSound"], "shock hits car"),
        ("powerup.shock.impact.shield", "ShockHit", "ShockHit.dat", ["PickupHitShieldSound"], "shock hits shield"),
        ("powerup.shock.explode", "ShockProjectile", "ShockProjectile.dat", ["PickupExplodeSound"], "shock explode"),
        ("powerup.barge.activate", "Barge", "BargeFire.dat", ["BargeFireSound"], "barge activation"),
        ("powerup.barge.last_gasp", "Barge", "BargeFire.dat", ["BargeLastGaspSound"], "barge last gasp"),
        ("powerup.barge.impact", "BargeHit", "BargeHit.dat", ["BargeHitCarSound"], "barge hits car"),
        ("powerup.barge.impact.shield", "BargeHit", "BargeHit.dat", ["BargeHitShieldSound"], "barge hits shield"),
        ("powerup.mine.throw.forward", "Bomb", "BombFire.dat", ["BombForwardsFireSound"], "mine thrown forward"),
        ("powerup.mine.throw.backward", "Bomb", "BombFire.dat", ["BombBackwardsFireSound"], "mine thrown backward"),
        ("powerup.mine.arm", "BombProjectile", "BombProjectile.dat", ["BombActiveSound"], "mine arm loop"),
        ("powerup.mine.explode", "BombProjectile", "BombProjectile.dat", ["BombExplodeSound"], "mine explode"),
        ("powerup.mine.explode.lfe", "BombProjectile", "BombProjectile.dat", ["BombExplodeLFESound"], "mine explode LFE"),
        ("powerup.mine.mini.created", "BombProjectile", "BombProjectile.dat", ["BombMiniCreatedSound"], "mini mine created"),
        ("powerup.mine.impact", "BombHit", "BombHit.dat", ["BombHitCarSound"], "mine hits car"),
        ("powerup.mine.impact.shield", "BombHit", "BombHit.dat", ["BombHitShieldSound"], "mine hits shield"),
        ("powerup.shunt.charge", "Shunt", "ShuntFire.dat", ["ShuntChargeSound"], "shunt charge"),
        ("powerup.shunt.activate", "Shunt", "ShuntFire.dat", ["ShuntFireSound"], "shunt activation"),
        ("powerup.shunt.projectile_loop", "ShuntProjectile", "ShuntProjectile.dat", ["PickupActiveSound"], "shunt projectile loop"),
        ("powerup.shunt.impact", "ShuntHit", "ShuntHit.dat", ["PickupHitCarSound"], "shunt hits car"),
        ("powerup.shunt.impact.shield", "ShuntHit", "ShuntHit.dat", ["PickupHitShieldSound"], "shunt hits shield"),
        ("powerup.shunt.impact.world", "ShuntProjectile", "ShuntProjectile.dat", ["PickupHitWorldSound"], "shunt hits world"),
        ("powerup.shunt.impact.projectile", "ShuntProjectile", "ShuntProjectile.dat", ["PickupHitProjectileSound"], "shunt hits projectile"),
        ("powerup.bolt.activate", "BlindFire", "BlindFireFire.dat", ["BlindFireFireSound"], "bolt activation"),
        ("powerup.bolt.projectile_loop", "BlindFireProjectile", "BlindFireProjectile.dat", ["PickupActiveSound"], "bolt projectile loop"),
        ("powerup.bolt.impact", "BlindFireHit", "BlindFireHit.dat", ["PickupHitCarSound"], "bolt hits car"),
        ("powerup.bolt.impact.shield", "BlindFireHit", "BlindFireHit.dat", ["PickupHitShieldSound"], "bolt hits shield"),
        ("powerup.bolt.impact.world", "BlindFireProjectile", "BlindFireProjectile.dat", ["PickupHitWorldSound"], "bolt hits world"),
        ("powerup.shield.loop", "Shield", "ShieldHit.dat", ["ShieldActiveSound"], "shield active loop"),
        ("powerup.shield.activate.mod", "Shield", "ShieldHit.dat", ["MOD_ShieldActivateSound"], "mod shield loop"),
        ("powerup.shield.hit_start", "Shield", "ShieldHit.dat", ["ShieldHitStartSound"], "shield hit start"),
        ("powerup.shield.hit", "Shield", "ShieldHit.dat", ["ShieldHitSound"], "shield hit"),
        ("powerup.shield.hit_stop", "Shield", "ShieldHit.dat", ["ShieldHitStopSound"], "shield hit stop"),
        ("powerup.repair.activate", "Repair", "RepairHit.dat", ["RepairActivateSound"], "repair activation"),
        ("powerup.mod.splash_damage", "Barge", "BargeFire.dat", ["MOD_SplashDamageFireSound"], "splash damage mod"),
        ("powerup.hit.lfe", "ShockHit", "ShockHit.dat", ["PickupHitLFESound"], "shared perk hit LFE"),
    ]
    for ev, entity, graph, comps, trigger in powerups:
        rows.append(spec(ev, "powerup", entity, graph, comps, trigger))

    # ---- Engine (Race_V8 graph; six loops already decoded in P62/P71) -------
    rows.append(spec("engine.idle.720", "engine", "Race_V8_Race", "Race_V8_engine.dat",
                     ["Engine0Sound"], "idle layer 720 (Engine0Volume/Pitch curves)"))
    for label in ("1500", "1995", "3015", "4005", "4995", "6000"):
        rows.append(spec(f"engine.rpm.{label}", "engine", "Race_V8_Race", "Race_V8_engine.dat",
                         [f"Engine{('1500','1995','3015','4005','4995','6000').index(label)+1}Sound"],
                         f"RPM layer {label}"))
    rows.append(spec("engine.decel", "engine", "Race_V8_Race", "Race_V8_engine.dat",
                     ["Engine7Sound"], "decel layer (retail volume chain flat zero)"))
    for label in ("1500", "2505", "3495", "4500", "5490"):
        rows.append(spec(f"engine.induction.{label}", "engine", "Race_V8_Race", "Race_V8_engine.dat",
                         [f"Induction{('1500','2505','3495','4500','5490').index(label)}Sound"],
                         f"induction layer {label}"))
    for i, label in enumerate(("00", "02", "04", "06", "08")):
        rows.append(spec(f"engine.supercharger.{label}", "engine", "Race_V8_Race", "Race_V8_engine.dat",
                         [f"Supercharger{i}Sound"], f"supercharger layer {label}"))
    rows.append(spec("engine.steam_loop", "engine", "Race_V8_Race", "Race_V8_engine.dat",
                     ["SteamLoopingSound"], "steam loop"))
    rows.append(spec("engine.flames_loop", "engine", "Race_V8_Race", "Race_V8_engine.dat",
                     ["FlamesLoopingSound"], "flames loop"))

    # ---- Music (graphs expose the retail song/track names) -----------------
    music = [
        ("music.menu.press_start", "Music", "Music_Controller.dat", ["PressStartLoop"]),
        ("music.menu.press_start_fill", "Music", "Music_Controller.dat", ["PressStartFill"]),
        ("music.menu.opening", "Music", "Music_Controller.dat", ["MenuOpeningLoop"]),
        ("music.menu.variation0", "Music", "Music_Controller.dat", ["MenuVariation0Loop"]),
        ("music.menu.variation1", "Music", "Music_Controller.dat", ["MenuVariation1Loop"]),
        ("music.menu.variation2", "Music", "Music_Controller.dat", ["MenuVariation2Loop"]),
        ("music.menu.variation3", "Music", "Music_Controller.dat", ["MenuVariation3Loop"]),
        ("music.menu.loading", "Music", "Music_Controller.dat", ["MenuLoadingLoop"]),
        ("music.menu.race_pass_fill", "Music", "Music_Controller.dat", ["RacePassFill"]),
        ("music.menu.race_fail_fill", "Music", "Music_Controller.dat", ["RaceFailFill"]),
        ("music.race.finished", "Music", "Music_Controller.dat", ["RaceFinishedLoop"]),
        ("music.checkpoint.start", "Music_Checkpoint", "Music_Checkpoint.dat", ["CheckpointStartSound"]),
        ("music.checkpoint.low_to_med", "Music_Checkpoint", "Music_Checkpoint.dat", ["CheckpointLowtoMedSound"]),
        ("music.checkpoint.med_to_high", "Music_Checkpoint", "Music_Checkpoint.dat", ["CheckpointMedtoHighSound"]),
        ("music.checkpoint.high_to_med", "Music_Checkpoint", "Music_Checkpoint.dat", ["CheckpointHightoMedSound"]),
        ("music.checkpoint.med_to_low", "Music_Checkpoint", "Music_Checkpoint.dat", ["CheckpointMedtoLowSound"]),
        ("music.checkpoint.last", "Music_Checkpoint", "Music_Checkpoint.dat", ["CheckpointLastCheckpointSound"]),
        ("music.checkpoint.loop.sync", "Music_Checkpoint", "Music_Checkpoint.dat", ["CheckpointSyncLoop"]),
        ("music.checkpoint.loop.low", "Music_Checkpoint", "Music_Checkpoint.dat", ["CheckpointLowIntensityLoop"]),
        ("music.checkpoint.loop.med", "Music_Checkpoint", "Music_Checkpoint.dat", ["CheckpointMedIntensityLoop"]),
        ("music.checkpoint.loop.high", "Music_Checkpoint", "Music_Checkpoint.dat", ["CheckpointHighIntensityLoop"]),
        ("music.checkpoint.loop.last", "Music_Checkpoint", "Music_Checkpoint.dat", ["CheckpointLastCheckpointLoop"]),
        ("music.boss.start.01", "Music_Boss", "Music_Boss.dat", ["Boss1StartSound"]),
        ("music.boss.start.02", "Music_Boss", "Music_Boss.dat", ["Boss2StartSound"]),
        ("music.boss.start.03", "Music_Boss", "Music_Boss.dat", ["Boss3StartSound"]),
        ("music.boss.start.04", "Music_Boss", "Music_Boss.dat", ["Boss4StartSound"]),
        ("music.boss.start.05", "Music_Boss", "Music_Boss.dat", ["Boss5StartSound"]),
        ("music.boss.start.06", "Music_Boss", "Music_Boss.dat", ["Boss6StartSound"]),
        ("music.boss.start.07", "Music_Boss", "Music_Boss.dat", ["Boss7StartSound"]),
        ("music.boss.start.08", "Music_Boss", "Music_Boss.dat", ["Boss8StartSound"]),
        ("music.boss.start.09", "Music_Boss", "Music_Boss.dat", ["Boss9StartSound"]),
        ("music.boss.fill.behind", "Music_Boss", "Music_Boss.dat", ["BossFill1"]),
        ("music.boss.fill.ahead", "Music_Boss", "Music_Boss.dat", ["BossFill2"]),
        ("music.boss.pass.boss", "Music_Boss", "Music_Boss.dat", ["BossPassPlayerFill"]),
        ("music.boss.pass.player", "Music_Boss", "Music_Boss.dat", ["PlayerPassBossFill"]),
        ("music.boss.loop.sync", "Music_Boss", "Music_Boss.dat", ["BossSyncLoop"]),
        ("music.boss.loop.losing", "Music_Boss", "Music_Boss.dat", ["BossLosingLoop"]),
        ("music.boss.loop.close", "Music_Boss", "Music_Boss.dat", ["BossCloseLoop"]),
        ("music.boss.loop.winning", "Music_Boss", "Music_Boss.dat", ["BossWinningLoop"]),
        ("music.destruction.start", "Music_Destruction", "Music_Destruction.dat", ["DestructionStartSound"]),
        ("music.destruction.low_to_med", "Music_Destruction", "Music_Destruction.dat", ["DestructionLowtoMedSound"]),
        ("music.destruction.med_to_high", "Music_Destruction", "Music_Destruction.dat", ["DestructionMedtoHighSound"]),
        ("music.destruction.high_to_med", "Music_Destruction", "Music_Destruction.dat", ["DestructionHightoMedSound"]),
        ("music.destruction.med_to_low", "Music_Destruction", "Music_Destruction.dat", ["DestructionMedtoLowSound"]),
        ("music.destruction.loop.sync", "Music_Destruction", "Music_Destruction.dat", ["DestructionSyncLoop"]),
        ("music.destruction.loop.low", "Music_Destruction", "Music_Destruction.dat", ["DestructionLowIntensityLoop"]),
        ("music.destruction.loop.med", "Music_Destruction", "Music_Destruction.dat", ["DestructionMedIntensityLoop"]),
        ("music.destruction.loop.high", "Music_Destruction", "Music_Destruction.dat", ["DestructionHighIntensityLoop"]),
    ]
    for ev, entity, graph, comps in music:
        rows.append(spec(ev, "music", entity, graph, comps, "music graph component"))
    # In-game / vista tracks: one event per retail track name.
    in_game = ["AtomicMoog", "Bump", "Coleen", "Delucid", "DemNaLikeMe",
               "EverythingIsUnderControl", "GadgetFunk", "HarvestDance", "LetThereBeLight",
               "MakeItSo", "Nothing2Step2", "OnTheRun", "PatPong", "RedLaserBeam",
               "Stompbox", "SWAG", "TeQuiero", "ThatGirl", "BLUR_track1", "BLUR_track2",
               "BLUR_track3", "BLUR_track4", "BLUR_track5"]
    for i, name in enumerate(in_game):
        rows.append(spec(f"music.ingame.track{i:02d}", "music", "Music", "Music_Controller.dat",
                         [f"InGameMusic{i:02d}"], f"in-game track {name}"))
    vistas = ["Amboy", "AmboyBowl", "BarcelonaBowl", "BarcelonaGracia", "BarcelonaOval",
              "Brighton", "Hackney", "HollywoodHills", "LADocks", "LADowntown",
              "LAFigureOfEight", "LAHighRise", "LARiver", "MountHaruna", "NYDumbo",
              "SFRussianHill", "SFSausalito", "TokyoShutoko"]
    for name in vistas:
        rows.append(spec(f"music.vista.{name}", "music", "Music", "Music_Controller.dat",
                         [f"Vista{name}"], f"vista track {name}"))
    return rows


def resolve_bank_wave(banks: dict, by_name: dict, bank_name: str, wave_name: str):
    candidates = []
    for key in by_name.get(bank_name.lower(), []):
        bank = banks[key]
        for wave in bank["waves"]:
            if wave["name"].lower() == wave_name.lower():
                candidates.append((key, bank, wave))
    if not candidates:
        return None
    # Prefer a non-streaming in-bank payload, then the smallest bank.
    def rank(item):
        _key, bank, wave = item
        return (int(bank["streaming"]), int(not wave.get("inBank")),
                int(bank["logicalBytes"]))
    return sorted(candidates, key=rank)[0]


def build_events(banks, by_name, entities, graphs, decode_categories):
    entity_by_name = {e["name"]: e for e in entities}
    events = []
    seen = set()
    for row in event_specs():
        if row["event"] in seen:
            raise ValueError(f"duplicate event {row['event']}")
        seen.add(row["event"])
        graph = graphs.get(row["graph"].lower())
        entity = entity_by_name.get(row["entity"])
        entry = {
            "event": row["event"], "category": row["category"],
            "entity": row["entity"], "entityRefId": entity["refId"] if entity else None,
            "graph": row["graph"], "trigger": row["trigger"],
            "triggerBasis": "retail AudioEntityDef name + audio graph component name",
            "variants": [], "status": "unsupported", "reason": None,
        }
        if not graph or not graph.get("sounds"):
            entry["reason"] = "graph-not-shipped"
            events.append(entry)
            continue
        sound_by_name = {s["name"]: s for s in graph["sounds"]}
        variants = []
        for comp_name in row["components"]:
            sound = sound_by_name.get(comp_name)
            if not sound:
                variants.append({"component": comp_name, "status": "unsupported",
                                 "reason": "component-not-found", "bank": None, "wave": None})
                continue
            for wave_name in sound["waves"]:
                found = resolve_bank_wave(banks, by_name, sound["bank"], wave_name)
                base = {
                    "component": comp_name, "componentIndex": sound["componentIndex"],
                    "soundType": sound["type"], "bank": sound["bank"], "wave": wave_name,
                    "options": sound["options"], "literalGain": sound["literalGain"],
                    "literalGainDb": sound["literalGainDb"], "literalRate": sound["literalRate"],
                }
                if not found:
                    base.update({"status": "unsupported", "reason": "bank-or-wave-not-shipped"})
                    variants.append(base)
                    continue
                key, bank, wave = found
                base.update({
                    "asset": bank["asset"], "pak": bank["pak"],
                    "bankName": bank["bankName"], "bankSha256": bank["bankSha256"],
                    "waveIndex": wave["index"], "waveUid": wave_uid(bank["bankName"], wave["index"], wave["name"]),
                    "dataStart": wave["dataStart"], "dataLength": wave["dataLength"],
                    "codec": wave["codec"], "sampleRate": wave.get("sampleRate"),
                    "channels": wave.get("channels"), "samples": wave.get("samples"),
                    "loop": bool(wave.get("loop")),
                    "durationSeconds": (round(wave["samples"] / wave["sampleRate"], 6)
                                        if wave.get("samples") and wave.get("sampleRate") else None),
                })
                if bank["streaming"] or not wave.get("inBank"):
                    base.update({"status": "unsupported", "reason": "streaming-container"})
                elif wave["format"] != 7:
                    base.update({"status": "unsupported", "reason": "codec-not-implemented"})
                else:
                    base["status"] = "decodable"
                variants.append(base)
        entry["variants"] = variants
        statuses = [v["status"] for v in variants]
        if "decoded" in statuses:
            entry["status"] = "decoded"
        elif "decodable" in statuses:
            entry["status"] = "decodable"
        else:
            entry["status"] = "unsupported"
            reasons = [v.get("reason") for v in variants if v.get("reason")]
            entry["reason"] = reasons[0] if reasons else "no-wave"
        entry["variantStatus"] = dict(Counter(statuses))
        # decode decision is applied later by apply_manifest
        events.append(entry)
    return events


# ------------------------------------------------------------------------- manifest
def wav_header(path: Path) -> dict:
    with wave.open(str(path), "rb") as fh:
        return {"channels": fh.getnchannels(), "sampleRate": fh.getframerate(),
                "samples": fh.getnframes(), "bitsPerSample": fh.getsampwidth() * 8}


def stats_pcm(samples: list[float]) -> dict:
    peak = max((abs(x) for x in samples), default=0.0)
    rms = math.sqrt(sum(x * x for x in samples) / len(samples)) if samples else 0.0
    return {"peak": round(peak, 9), "rms": round(rms, 9)}


def decode_manifest_wave(bank: dict, wave: dict, bank_bytes: bytes) -> tuple[list[float], int, int, dict]:
    meta = {
        "format": wave["format"], "dataStart": wave["dataStart"],
        "dataLength": wave["dataLength"], "name": wave["name"],
        "adpcm": {"channels": wave["channels"], "samples": wave["samples"],
                  "sampleRate": wave["sampleRate"]},
    }
    payload = bank_bytes[wave["dataStart"]:wave["dataStart"] + wave["dataLength"]]
    samples, extent = decode_adpcm(payload, wave["channels"], wave["samples"])
    return samples, wave["channels"], wave["sampleRate"], extent


def build_manifest(banks, by_name, events, graphs, decode_categories):
    # Candidate waves for new decoding: every UI/race/powerup variant that is
    # decodable, unique by wave UID.
    candidates: dict[str, dict] = {}
    for event in events:
        if event["category"] not in decode_categories:
            continue
        for v in event["variants"]:
            if v.get("status") == "decodable" and v.get("waveUid"):
                candidate = dict(v)
                candidate["_event"] = event["event"]
                candidates.setdefault(v["waveUid"], candidate)
    # Existing decoded waves from earlier audio tasks.
    existing = []
    engine = [("engine.idle.720", "RaceV8_Engine_720"),
              ("engine.rpm.1500", "RaceV8_Engine_1500"), ("engine.rpm.1995", "RaceV8_Engine_1995"),
              ("engine.rpm.3015", "RaceV8_Engine_3015"), ("engine.rpm.4005", "RaceV8_Engine_4005"),
              ("engine.rpm.4995", "RaceV8_Engine_4995"), ("engine.rpm.6000", "RaceV8_Engine_6000")]
    for event_name, wave_name in engine:
        existing.append(("Race_V8", wave_name, event_name))
    tyre = [
        ("tyre.dry.road", "Asphalt_Road", "Wheel_dry"),
        ("tyre.dry.skid0", "Asphalt_Lateral_1", "Wheel_dry"),
        ("tyre.dry.skid1", "Asphalt_Lateral_2", "Wheel_dry"),
        ("tyre.dry.skid2", "Asphalt_Lateral_3", "Wheel_dry"),
        ("tyre.dry.spin", "Asphalt_Spin", "Wheel_dry"),
        ("tyre.offroad.gravel.road", "Gravel_road", "Wheel_offroad"),
        ("tyre.offroad.gravel.skid", "Gravel_skid", "Wheel_offroad"),
        ("tyre.offroad.grass.road", "Dirt_road", "Wheel_offroad"),
        ("tyre.offroad.grass.skid", "Dirt_skid", "Wheel_offroad"),
        ("tyre.offroad.sand.road", "Sand_road", "Wheel_offroad"),
        ("tyre.offroad.sand.skid", "Sand_skid", "Wheel_offroad"),
        ("tyre.offroad.foliage.road", "Foliage_road", "Wheel_offroad"),
    ]
    for event_name, wave_name, bank_name in tyre:
        existing.append((bank_name, wave_name, event_name))
    collision = [
        ("collision.world.concrete", "DO_concrete_large"),
        ("collision.world.vegetation", "DO_vegetation_hedge"),
        ("collision.world.wood", "DO_wood_fence"),
        ("collision.world.metal", "DO_metal_sheet"),
        ("collision.world.glass", "DO_glass_hit"),
        ("collision.world.rubber", "DO_rubber_tyre"),
        ("collision.world.concrete_fence_chain", "DO_concrete_fence_chain"),
        ("collision.world.concrete_fence_plastic", "DO_concrete_fence_plastic"),
        ("collision.world.metal_hollow", "DO_metal_hollow_large"),
        ("collision.world.metal_armco", "DO_metal_armco"),
        ("collision.world.metal_fence_chain", "DO_metal_fence_chainlink"),
        ("collision.world.metal_fence_solid", "DO_metal_solid_medium"),
        ("collision.world.metal_fence_slatted", "DO_metal_railing"),
        ("collision.world.metal_solid_post", "DO_metal_post_tall"),
    ]
    # Reuse the 3-wave retail tables decoded by the tyre/collision task.
    collision_graph = graphs.get("collisionworld.dat") or {}
    table_by_bank = {s["bank"]: s.get("waves", []) for s in collision_graph.get("sounds", [])}
    for event_name, bank_name in collision:
        for wave_name in table_by_bank.get(bank_name, []):
            existing.append((bank_name, wave_name, event_name))
    existing_entries = []
    for bank_name, wave_name, event_name in existing:
        found = resolve_bank_wave(banks, by_name, bank_name, wave_name)
        if not found:
            continue
        _key, bank, wave = found
        path = OUT / f"{wave['name']}.wav"
        if not path.exists():
            continue
        hdr = wav_header(path)
        existing_entries.append({
            "waveUid": wave_uid(bank["bankName"], wave["index"], wave["name"]),
            "event": event_name, "bank": bank["bankName"], "asset": bank["asset"],
            "pak": bank["pak"], "bankSha256": bank["bankSha256"],
            "waveIndex": wave["index"], "wave": wave["name"],
            "dataStart": wave["dataStart"], "dataLength": wave["dataLength"],
            "codec": wave["codec"], "sampleRate": hdr["sampleRate"],
            "channels": hdr["channels"], "samples": hdr["samples"],
            "loop": bool(wave.get("loop")), "loopStart": 0,
            "loopEnd": wave.get("samples") if wave.get("loop") else None,
            "durationSeconds": round(hdr["samples"] / hdr["sampleRate"], 6),
            "file": str(path.relative_to(ROOT)).replace("\\", "/"),
            "bytes": path.stat().st_size, "sha256": sha256_file(path),
            "source": "existing-decoded",
        })
    # Decode the new set.
    new_entries = []
    WAV_DIR.mkdir(parents=True, exist_ok=True)
    for uid, v in sorted(candidates.items()):
        key = next((k for k, b in banks.items() if b["bankName"] == v["bankName"]), None)
        bank = banks[key]
        wave = next(w for w in bank["waves"] if w["index"] == v["waveIndex"])
        pak = GAME / bank["pak"]
        entry = next(e for e in pak_index(pak)["entries"] if e["path"].lower() == bank["asset"].lower())
        bank_bytes = read_asset(pak, entry)
        samples, channels, rate, extent = decode_manifest_wave(bank, wave, bank_bytes)
        out_dir = WAV_DIR / "".join(c if c.isalnum() or c in "-_." else "_" for c in bank["bankName"])
        out_dir.mkdir(parents=True, exist_ok=True)
        path = out_dir / f"{''.join(c if c.isalnum() or c in '-_.' else '_' for c in wave['name'])}.wav"
        write_wav(path, samples, channels, rate)
        st = stats_pcm(samples)
        frames = len(samples) // channels
        new_entries.append({
            "waveUid": uid, "event": v.get("event"), "bank": bank["bankName"],
            "asset": bank["asset"], "pak": bank["pak"], "bankSha256": bank["bankSha256"],
            "waveIndex": wave["index"], "wave": wave["name"],
            "dataStart": wave["dataStart"], "dataLength": wave["dataLength"],
            "codec": wave["codec"], "sampleRate": rate, "channels": channels,
            "samples": frames, "loop": bool(wave.get("loop")),
            "loopStart": 0, "loopEnd": frames if wave.get("loop") else None,
            "durationSeconds": round(frames / rate, 6) if rate else None,
            "file": str(path.relative_to(ROOT)).replace("\\", "/"),
            "bytes": path.stat().st_size, "sha256": sha256_file(path),
            "source": "decoded",
            "extent": extent,
            **st,
        })
    entries = existing_entries + new_entries
    # Deterministic order, no duplicate UID.
    by_uid = {}
    for e in entries:
        by_uid.setdefault(e["waveUid"], e)
    entries = sorted(by_uid.values(), key=lambda e: (e["bank"].lower(), e["waveIndex"]))
    total = sum(e["bytes"] for e in entries)
    new_bytes = sum(e["bytes"] for e in entries if e["source"] == "decoded")
    existing_bytes = total - new_bytes
    manifest = {
        "generatedBy": "probes/audio/audio_catalog.py",
        "note": "Decoded retail waves only; no synthesis, resampling or trimming. "
                "Existing entries reuse the WAVs verified by the tyre/collision and engine tasks.",
        "entries": entries,
        "counts": {
            "total": len(entries),
            "newlyDecoded": sum(1 for e in entries if e["source"] == "decoded"),
            "existingDecoded": sum(1 for e in entries if e["source"] == "existing-decoded"),
            "loops": sum(1 for e in entries if e["loop"]),
            "oneShots": sum(1 for e in entries if not e["loop"]),
        },
        "bytes": {"total": total, "newlyDecoded": new_bytes, "existingDecoded": existing_bytes},
        "banks": dict(Counter(e["bank"] for e in entries)),
        "codecs": dict(Counter(e["codec"] for e in entries)),
        "sampleRates": dict(Counter(str(e["sampleRate"]) for e in entries)),
        "channels": dict(Counter(str(e["channels"]) for e in entries)),
    }
    return manifest


def apply_manifest(events, manifest):
    by_uid = {e["waveUid"]: e for e in manifest["entries"]}
    for event in events:
        for v in event["variants"]:
            if v.get("waveUid") in by_uid:
                v["status"] = "decoded"
                v["manifestFile"] = by_uid[v["waveUid"]]["file"]
                v["manifestSha256"] = by_uid[v["waveUid"]]["sha256"]
                v["manifestBytes"] = by_uid[v["waveUid"]]["bytes"]
                v["source"] = by_uid[v["waveUid"]]["source"]
        statuses = [v["status"] for v in event["variants"]]
        if "decoded" in statuses:
            event["status"] = "decoded"
            event["reason"] = None
        elif "decodable" in statuses:
            event["status"] = "decodable"
            event["reason"] = None
        else:
            event["status"] = "unsupported"
            reasons = [v.get("reason") for v in event["variants"] if v.get("reason")]
            event["reason"] = reasons[0] if reasons else "no-wave"
        event["variantStatus"] = dict(Counter(statuses))


# ---------------------------------------------------------------------------- contract
def build_contract(events, manifest):
    group_defaults = {
        "ui": {"bus": "ui", "priority": 90, "duckGroup": "music", "provisional": True},
        "race": {"bus": "hud", "priority": 80, "duckGroup": "music", "provisional": True},
        "powerup": {"bus": "perks", "priority": 70, "duckGroup": None, "provisional": True},
        "engine": {"bus": "vehicle", "priority": 50, "duckGroup": None, "provisional": True},
        "tyre": {"bus": "vehicle", "priority": 40, "duckGroup": None, "provisional": True},
        "collision": {"bus": "world", "priority": 60, "duckGroup": None, "provisional": True},
        "music": {"bus": "music", "priority": 20, "duckGroup": None, "provisional": True},
        "ambience": {"bus": "ambience", "priority": 10, "duckGroup": None, "provisional": True},
    }
    entries = {}
    unsupported = {}
    for event in events:
        decoded = [v for v in event["variants"] if v["status"] == "decoded"]
        if not decoded:
            unsupported[event["event"]] = {"status": event["status"], "reason": event["reason"]}
            continue
        variants = []
        for v in decoded:
            gain = v.get("literalGain")
            opts = v.get("options") or {}
            rate = v.get("literalRate")
            variants.append({
                "file": v["manifestFile"], "sha256": v["manifestSha256"],
                "bytes": v["manifestBytes"], "waveUid": v["waveUid"],
                "loop": v["loop"], "loopStart": 0,
                "loopEnd": v["samples"] if v["loop"] else None,
                "gainLinear": gain, "gainDb": v.get("literalGainDb"),
                "gainProvisional": gain is None,
                "frequency": opts.get("frequency", {}).get("fVal") if opts.get("frequency", {}).get("literal") else None,
                "pitchOctaves": opts.get("pitch", {}).get("fVal") if opts.get("pitch", {}).get("literal") else None,
                "rate": rate if rate is not None else 1.0,
                "rateProvisional": rate is None,
                "bank": v["bankName"], "wave": v["wave"],
            })
        g = group_defaults.get(event["category"], {"bus": "default", "priority": 0,
                                                    "duckGroup": None, "provisional": True})
        entries[event["event"]] = {
            "category": event["category"], "entity": event["entity"],
            "graph": event["graph"], "trigger": event["trigger"],
            "bus": g["bus"], "priority": g["priority"], "duckGroup": g["duckGroup"],
            "priorityProvisional": True,
            "variants": variants,
            "provenance": {
                "basis": event["triggerBasis"],
                "entityRefId": event["entityRefId"],
                "graph": event["graph"],
            },
        }
    return {
        "generatedBy": "probes/audio/audio_catalog.py",
        "note": "Retail gain is optLevel(linear) * 10^(optGain_dB/20); retail rate is "
                "optFrequency * 2^optPitch. Priority/ducking are integration choices, "
                "not decoded retail values, and are marked provisional.",
        "groups": group_defaults,
        "events": entries,
        "unsupported": unsupported,
    }


# ------------------------------------------------------------------------------- main
def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-manifest", action="store_true")
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    CATALOG_DIR.mkdir(parents=True, exist_ok=True)

    print("banks...")
    banks, by_name, bank_summary = build_banks()
    print("entities...")
    entities, entity_summary = build_entities()
    print("graphs...")
    graphs, graph_errors = build_graphs()
    print("events...")
    events = build_events(banks, by_name, entities, graphs, {"ui", "race", "powerup"})

    # Add generated event families: ambience, collision, tyre, other engines.
    ambience = []
    for entity in entities:
        if not (entity["name"] or "").startswith("AMB_"):
            continue
        files = [o["file"] for o in entity["objects"] if o["file"]]
        if not files:
            continue
        graph_name = files[0]
        graph = graphs.get(graph_name.lower())
        if not graph or not graph.get("sounds"):
            continue
        comps = [s["name"] for s in graph["sounds"]]
        if not comps:
            continue
        ambience.append(spec(f"ambience.{entity['name'][4:].lower()}", "ambience",
                             entity["name"], graph_name, comps, "ambience entity graph"))
    for row in ambience:
        events.append(build_one_event(row, banks, by_name, entities, graphs))
    # Collision world routes (already decoded; the 14 material tables).
    collision = [
        ("collision.world.concrete", "CollisionWorld", "CollisionWorld.dat", ["Concrete_LargeCollisionSound"]),
        ("collision.world.vegetation", "CollisionWorld", "CollisionWorld.dat", ["vegetation_hedgeCollisionSound"]),
        ("collision.world.wood", "CollisionWorld", "CollisionWorld.dat", ["wood_fenceCollisionSound"]),
        ("collision.world.metal", "CollisionWorld", "CollisionWorld.dat", ["metal_sheetCollisionSound"]),
        ("collision.world.glass", "CollisionWorld", "CollisionWorld.dat", ["glass_hitCollisionSound"]),
        ("collision.world.rubber", "CollisionWorld", "CollisionWorld.dat", ["rubber_tyreCollisionSound"]),
        ("collision.world.concrete_fence_chain", "CollisionWorld", "CollisionWorld.dat", ["concrete_fence_chainCollisionSound"]),
        ("collision.world.concrete_fence_plastic", "CollisionWorld", "CollisionWorld.dat", ["concrete_fence_plasticCollisionSound"]),
        ("collision.world.metal_hollow", "CollisionWorld", "CollisionWorld.dat", ["metal_hollow_largeCollisionSound"]),
        ("collision.world.metal_armco", "CollisionWorld", "CollisionWorld.dat", ["metal_armcoCollisionSound"]),
        ("collision.world.metal_fence_chain", "CollisionWorld", "CollisionWorld.dat", ["metal_fence_chainlinkCollisionSound"]),
        ("collision.world.metal_fence_solid", "CollisionWorld", "CollisionWorld.dat", ["metal_solid_mediumCollisionSound"]),
        ("collision.world.metal_fence_slatted", "CollisionWorld", "CollisionWorld.dat", ["metal_railingCollisionSound"]),
        ("collision.world.metal_solid_post", "CollisionWorld", "CollisionWorld.dat", ["metal_post_tallCollisionSound"]),
    ]
    for ev, entity, graph, comps in collision:
        events.append(build_one_event(spec(ev, "collision", entity, graph, comps,
                                           "CollisionWorld material table"), banks, by_name, entities, graphs))
    # Tyre layers (already decoded by the tyre task).
    tyre = [
        ("tyre.dry.road", "Wheel_dry", "Wheel_Dry.dat", ["Asphalt_Road_Sound"]),
        ("tyre.dry.skid0", "Wheel_dry", "Wheel_Dry.dat", ["Asphalt_Skid0_Sound"]),
        ("tyre.dry.skid1", "Wheel_dry", "Wheel_Dry.dat", ["Asphalt_Skid1_Sound"]),
        ("tyre.dry.skid2", "Wheel_dry", "Wheel_Dry.dat", ["Asphalt_Skid2_Sound"]),
        ("tyre.dry.spin", "Wheel_dry", "Wheel_Dry.dat", ["Asphalt_Spin_Sound"]),
        ("tyre.offroad.gravel.road", "Wheel_offroad", "Wheel_offroad.dat", ["Gravel_Road_Sound"]),
        ("tyre.offroad.gravel.skid", "Wheel_offroad", "Wheel_offroad.dat", ["Gravel_Skid_Sound"]),
        ("tyre.offroad.grass.road", "Wheel_offroad", "Wheel_offroad.dat", ["Grass_Road_Sound"]),
        ("tyre.offroad.grass.skid", "Wheel_offroad", "Wheel_offroad.dat", ["Grass_Skid_Sound"]),
        ("tyre.offroad.sand.road", "Wheel_offroad", "Wheel_offroad.dat", ["Sand_Road_Sound"]),
        ("tyre.offroad.sand.skid", "Wheel_offroad", "Wheel_offroad.dat", ["Sand_Skid_Sound"]),
        ("tyre.offroad.foliage.road", "Wheel_offroad", "Wheel_offroad.dat", ["Foliage_Road_Sound"]),
    ]
    for ev, entity, graph, comps in tyre:
        events.append(build_one_event(spec(ev, "tyre", entity, graph, comps,
                                           "tyre graph layer"), banks, by_name, entities, graphs))

    if not args.skip_manifest:
        print("manifest...")
        manifest = build_manifest(banks, by_name, events, graphs, {"ui", "race", "powerup"})
        apply_manifest(events, manifest)
    else:
        manifest = {"entries": [], "counts": {}, "bytes": {}}

    print("contract...")
    contract = build_contract(events, manifest)

    catalog = {
        "generatedBy": "probes/audio/audio_catalog.py",
        "note": "Read-only decode of retail audio. No invented audio; unsupported cases are typed.",
        "bankSummary": bank_summary,
        "entitySummary": entity_summary,
        "graphSummary": {
            "count": len(graphs),
            "parseErrors": graph_errors,
            "withSounds": sum(1 for g in graphs.values() if g.get("sounds")),
            "totalSounds": sum(len(g.get("sounds", [])) for g in graphs.values()),
        },
        "banks": banks,
        "entities": entities,
        "graphs": graphs,
        "events": events,
        "eventSummary": {
            "count": len(events),
            "byStatus": dict(Counter(e["status"] for e in events)),
            "byCategory": dict(Counter(e["category"] for e in events)),
            "byCategoryStatus": {c: dict(Counter(e["status"] for e in events if e["category"] == c))
                                 for c in sorted({e["category"] for e in events})},
        },
        "manifestSummary": manifest.get("counts", {}),
        "manifestBytes": manifest.get("bytes", {}),
        "contractSummary": {
            "events": len(contract["events"]),
            "unsupported": len(contract["unsupported"]),
        },
    }
    (OUT / "audio-catalog.json").write_text(json.dumps(catalog, indent=1) + "\n", encoding="utf-8")
    (OUT / "audio-manifest.json").write_text(json.dumps(manifest, indent=1) + "\n", encoding="utf-8")
    (OUT / "integration-contract.json").write_text(json.dumps(contract, indent=1) + "\n", encoding="utf-8")
    print(json.dumps(catalog["bankSummary"], indent=1))
    print(json.dumps(catalog["entitySummary"], indent=1))
    print(json.dumps(catalog["graphSummary"], indent=1))
    print(json.dumps(catalog["eventSummary"], indent=1))
    print(json.dumps(catalog["manifestSummary"], indent=1))
    print(json.dumps(catalog["manifestBytes"], indent=1))


def build_one_event(row, banks, by_name, entities, graphs):
    """Resolve one event row without adding manifest statuses (apply later)."""
    entity_by_name = {e["name"]: e for e in entities}
    graph = graphs.get(row["graph"].lower())
    entity = entity_by_name.get(row["entity"])
    entry = {
        "event": row["event"], "category": row["category"],
        "entity": row["entity"], "entityRefId": entity["refId"] if entity else None,
        "graph": row["graph"], "trigger": row["trigger"],
        "triggerBasis": "retail AudioEntityDef name + audio graph component name",
        "variants": [], "status": "unsupported", "reason": None,
    }
    if not graph or not graph.get("sounds"):
        entry["reason"] = "graph-not-shipped"
        return entry
    sound_by_name = {s["name"]: s for s in graph["sounds"]}
    for comp_name in row["components"]:
        sound = sound_by_name.get(comp_name)
        if not sound:
            entry["variants"].append({"component": comp_name, "status": "unsupported",
                                      "reason": "component-not-found", "bank": None, "wave": None})
            continue
        for wave_name in sound["waves"]:
            found = resolve_bank_wave(banks, by_name, sound["bank"], wave_name)
            base = {"component": comp_name, "componentIndex": sound["componentIndex"],
                    "soundType": sound["type"], "bank": sound["bank"], "wave": wave_name,
                    "options": sound["options"], "literalGain": sound["literalGain"],
                    "literalGainDb": sound["literalGainDb"], "literalRate": sound["literalRate"]}
            if not found:
                base.update({"status": "unsupported", "reason": "bank-or-wave-not-shipped"})
                entry["variants"].append(base)
                continue
            _key, bank, wave = found
            base.update({
                "asset": bank["asset"], "pak": bank["pak"], "bankName": bank["bankName"],
                "bankSha256": bank["bankSha256"], "waveIndex": wave["index"],
                "waveUid": wave_uid(bank["bankName"], wave["index"], wave["name"]),
                "dataStart": wave["dataStart"], "dataLength": wave["dataLength"],
                "codec": wave["codec"], "sampleRate": wave.get("sampleRate"),
                "channels": wave.get("channels"), "samples": wave.get("samples"),
                "loop": bool(wave.get("loop")),
                "durationSeconds": (round(wave["samples"] / wave["sampleRate"], 6)
                                    if wave.get("samples") and wave.get("sampleRate") else None),
            })
            if bank["streaming"] or not wave.get("inBank"):
                base.update({"status": "unsupported", "reason": "streaming-container"})
            elif wave["format"] != 7:
                base.update({"status": "unsupported", "reason": "codec-not-implemented"})
            else:
                base["status"] = "decodable"
            entry["variants"].append(base)
    statuses = [v["status"] for v in entry["variants"]]
    entry["status"] = ("decoded" if "decoded" in statuses else
                       "decodable" if "decodable" in statuses else "unsupported")
    if entry["status"] == "unsupported":
        reasons = [v.get("reason") for v in entry["variants"] if v.get("reason")]
        entry["reason"] = reasons[0] if reasons else "no-wave"
    entry["variantStatus"] = dict(Counter(statuses))
    return entry


if __name__ == "__main__":
    main()
