"""Verify the audio catalog, manifest and integration contract.

Checks (well over 250):
  * bank inventory counts, wave bounds, codec/rate/channel coverage
  * entity inventory and entity→graph references
  * graph parse coverage and sound-component provenance
  * event coverage and typed statuses
  * manifest provenance, file hashes, sizes, loop sanity, size accounting
  * two independent decodes per manifest entry, byte-identical to the file
  * integration-contract completeness and provisional marking

Exit code 0 only when every check passes. Writes
_work/audio/audio-catalog-verify.json.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
import struct
import sys
import wave
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "probes/audio"))

from inspect_asset_layout import pak_index  # noqa: E402
from extract_baf import decode_pak_asset, decode_adpcm  # noqa: E402

OUT = ROOT / "_work/audio"
GAME = ROOT / "game-data/Blur/cache"
CHECKS: list[dict] = []


def check(name: str, ok: bool, detail=None) -> None:
    CHECKS.append({"name": name, "ok": bool(ok), "detail": detail})


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def wav_bytes(samples: list[float], channels: int, rate: int) -> bytes:
    frames = bytearray()
    for value in samples:
        clipped = max(-1.0, min(1.0, value))
        frames += struct.pack("<h", int(round(clipped * 32767.0)))
    buf = io.BytesIO()
    with wave.open(buf, "wb") as out:
        out.setnchannels(channels)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes(frames)
    return buf.getvalue()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--quick", action="store_true", help="skip the two-run decode")
    args = parser.parse_args()

    catalog = json.loads((OUT / "audio-catalog.json").read_text(encoding="utf-8"))
    manifest = json.loads((OUT / "audio-manifest.json").read_text(encoding="utf-8"))
    contract = json.loads((OUT / "integration-contract.json").read_text(encoding="utf-8"))
    banks = catalog["banks"]
    bank_summary = catalog["bankSummary"]
    entities = catalog["entities"]
    graphs = catalog["graphs"]
    events = catalog["events"]

    # ------------------------------------------------------------- inventory
    check("bank count 193", bank_summary["banks"] == 193, bank_summary["banks"])
    check("wave count 2732", bank_summary["waves"] == 2732, bank_summary["waves"])
    check("bank summary waves == sum(bank waves)",
          bank_summary["waves"] == sum(len(b["waves"]) for b in banks.values()))
    check("uADPCM4Bit waves 2728", bank_summary["codecs"].get("uADPCM4Bit") == 2728,
          bank_summary["codecs"])
    check("PCM16 waves 4", bank_summary["codecs"].get("PCM16") == 4, bank_summary["codecs"])
    check("sample rates 48k + 36k",
          set(bank_summary["sampleRates"]) == {"48000", "36000"}, bank_summary["sampleRates"])
    check("channels mono + stereo",
          set(bank_summary["channels"]) == {"1", "2"}, bank_summary["channels"])
    check("streaming banks 19", bank_summary["streamingBanks"] == 19,
          bank_summary["streamingBanks"])
    check("loops + one-shots == waves",
          bank_summary["loops"] + bank_summary["oneShots"] == bank_summary["waves"])
    check("root.pak 126 banks", bank_summary["pakCounts"]["root.pak"]["banks"] == 126)
    check("root_streaming.pak 67 banks",
          bank_summary["pakCounts"]["root_streaming.pak"]["banks"] == 67)

    for key, bank in banks.items():
        tag = key.lower()
        check(f"bank {tag}: waveCount matches", bank["waveCount"] == len(bank["waves"]),
              (bank["waveCount"], len(bank["waves"])))
        check(f"bank {tag}: name/asset/pak", bool(bank["bankName"]) and bool(bank["asset"])
              and bank["pak"] in ("root.pak", "root_streaming.pak"))
        check(f"bank {tag}: indices unique",
              len({w["index"] for w in bank["waves"]}) == len(bank["waves"]))
        check(f"bank {tag}: sha or header-only",
              (bank.get("bankSha256") is None) if bank["streaming"] and bank["logicalBytes"] > 64 * 1024 * 1024
              else (isinstance(bank.get("bankSha256"), str) and len(bank["bankSha256"]) == 64))
        for w in bank["waves"]:
            check(f"bank {tag}: wave {w['index']} bounds",
                  w["dataStart"] >= 0 and w["dataLength"] > 0
                  and w["dataStart"] + w["dataLength"] <= bank["logicalBytes"],
                  (w["name"], w["dataStart"], w["dataLength"]))
            check(f"bank {tag}: wave {w['index']} codec/rate/channels",
                  w["codec"] in ("uADPCM4Bit", "PCM16")
                  and w.get("sampleRate") in (48000, 36000)
                  and w.get("channels") in (1, 2),
                  (w["name"], w["codec"], w.get("sampleRate"), w.get("channels")))
            check(f"bank {tag}: wave {w['index']} loop flag", isinstance(w.get("loop"), bool))

    # --------------------------------------------------------------- entities
    es = catalog["entitySummary"]
    check("entity count 228", es["entities"] == 228, es["entities"])
    check("entity rows == summary", len(entities) == es["entities"])
    check("audio objects 367", es["objects"] == 367, es["objects"])
    check("entity group records 11", es["entityGroups"] == 11, es["entityGroups"])
    check("entity group buckets sum",
          sum(es["groups"].values()) == es["entities"], es["groups"])
    check("entity groups names",
          set(es["groups"]) == {"Default", "Wheels", "Vehicle", "DynamicObjects",
                                "Perks", "Music", "Collision", "UI", "System", "Listener"})
    for e in entities:
        check(f"entity {e['name']}: refId/group",
              isinstance(e["refId"], int) and e["refId"] > 0 and bool(e["group"]),
              (e["record"], e["group"]))
        check(f"entity {e['name']}: objects list",
              isinstance(e["objects"], list) and all("refId" in o for o in e["objects"]))

    # ----------------------------------------------------------------- graphs
    gs = catalog["graphSummary"]
    check("graph count 365", gs["count"] == 365, gs["count"])
    check("graph parse errors 0", not gs["parseErrors"], gs["parseErrors"])
    check("graphs with sounds 274", gs["withSounds"] == 274, gs["withSounds"])
    check("total sound components 2601", gs["totalSounds"] == 2601, gs["totalSounds"])
    check("graph rows == summary", len(graphs) == gs["count"])
    for name, g in graphs.items():
        check(f"graph {name}: sha/byteLength",
              isinstance(g.get("sha256"), str) and len(g["sha256"]) == 64
              and g.get("byteLength", 0) > 0)
        if g.get("sounds"):
            for s in g["sounds"]:
                check(f"graph {name}: sound {s['name']} bank/waves",
                      bool(s.get("bank")) and isinstance(s.get("waves"), list)
                      and len(s["waves"]) > 0, (s["bank"], s["waves"]))

    # ----------------------------------------------------------------- events
    names = [e["event"] for e in events]
    check("event names unique", len(names) == len(set(names)), len(names))
    check("event count 335", len(events) == 335, len(events))
    check("event statuses valid",
          all(e["status"] in ("decoded", "decodable", "unsupported") for e in events))
    check("event categories valid",
          all(e["category"] in ("ui", "race", "powerup", "engine", "music",
                                "ambience", "collision", "tyre") for e in events))
    check("event status sum", sum(catalog["eventSummary"]["byStatus"].values()) == len(events))
    check("event category sum", sum(catalog["eventSummary"]["byCategory"].values()) == len(events))

    manifest_by_uid = {m["waveUid"]: m for m in manifest["entries"]}
    check("manifest UID map unique", len(manifest_by_uid) == len(manifest["entries"]))

    required = {
        "ui.navigate.forward", "ui.navigate.backward", "ui.confirm",
        "race.countdown.long", "race.start", "race.lap.pass", "race.finish.in",
        "race.position.in", "race.wreck", "powerup.pickup",
        "powerup.nitro.activate", "powerup.shock.activate", "powerup.barge.activate",
        "powerup.mine.arm", "powerup.mine.explode", "powerup.shunt.activate",
        "powerup.bolt.activate", "powerup.shield.loop", "powerup.repair.activate",
        "powerup.nitro.loop.whine", "engine.rpm.1500", "engine.rpm.6000",
        "engine.idle.720",
        "music.menu.opening", "music.ingame.track00", "music.vista.Amboy",
        "ambience.crowd_small", "collision.world.metal", "tyre.dry.road",
    }
    check("required events present", required <= set(names),
          sorted(required - set(names)))
    for e in events:
        check(f"event {e['event']}: variants", bool(e["variants"]))
        check(f"event {e['event']}: trigger/entity/graph",
              bool(e["trigger"]) and bool(e["entity"]) and bool(e["graph"]))
        statuses = [v["status"] for v in e["variants"]]
        check(f"event {e['event']}: variant statuses valid",
              all(s in ("decoded", "decodable", "unsupported") for s in statuses))
        if e["status"] == "decoded":
            check(f"event {e['event']}: has decoded variant", "decoded" in statuses)
        if e["status"] == "unsupported":
            check(f"event {e['event']}: typed reason", bool(e.get("reason")))
        for v in e["variants"]:
            if v["status"] == "decoded":
                check(f"event {e['event']}: manifest entry {v.get('waveUid')}",
                      v.get("waveUid") in manifest_by_uid)
                entry = manifest_by_uid.get(v.get("waveUid"))
                if entry:
                    check(f"event {e['event']}: manifest hash",
                          entry["sha256"] == v.get("manifestSha256"))
                    check(f"event {e['event']}: manifest bytes",
                          entry["bytes"] == v.get("manifestBytes"))
            elif v["status"] == "decodable":
                check(f"event {e['event']}: decodable has wave",
                      bool(v.get("waveUid")) and v.get("reason") is None)
            else:
                check(f"event {e['event']}: unsupported variant reason",
                      bool(v.get("reason")))

    # Category expectations.
    for e in events:
        if e["category"] in ("ui", "race", "powerup"):
            check(f"event {e['event']}: {e['category']} decoded", e["status"] == "decoded",
                  e["status"])
        if e["category"] in ("collision", "tyre"):
            check(f"event {e['event']}: {e['category']} decoded", e["status"] == "decoded",
                  e["status"])
        if e["category"] == "engine" and e["event"].startswith("engine.rpm."):
            check(f"event {e['event']}: engine rpm decoded", e["status"] == "decoded")
        if e["category"] == "music":
            check(f"event {e['event']}: music status",
                  e["status"] in ("decodable", "unsupported"))
        if e["category"] == "ambience":
            check(f"event {e['event']}: ambience decodable", e["status"] == "decodable")

    # ----------------------------------------------------------------- manifest
    counts = manifest["counts"]
    check("manifest count 221", counts["total"] == 221, counts)
    check("manifest new 160", counts["newlyDecoded"] == 160, counts["newlyDecoded"])
    check("manifest existing 61", counts["existingDecoded"] == 61, counts["existingDecoded"])
    check("manifest entries == counts", len(manifest["entries"]) == counts["total"])
    check("manifest loop count", counts["loops"] == sum(1 for m in manifest["entries"] if m["loop"]))
    total_bytes = sum(m["bytes"] for m in manifest["entries"])
    check("manifest byte total", manifest["bytes"]["total"] == total_bytes,
          (manifest["bytes"]["total"], total_bytes))
    check("manifest byte split",
          manifest["bytes"]["newlyDecoded"] + manifest["bytes"]["existingDecoded"]
          == manifest["bytes"]["total"])
    check("manifest new bytes == sum",
          manifest["bytes"]["newlyDecoded"] == sum(m["bytes"] for m in manifest["entries"]
                                                    if m["source"] == "decoded"))
    check("manifest codecs", set(manifest["codecs"]) == {"uADPCM4Bit"})
    check("manifest sample rates", set(manifest["sampleRates"]) == {"48000"},
          manifest["sampleRates"])
    check("manifest channels", set(manifest["channels"]) <= {"1", "2"},
          manifest["channels"])

    # Bank lookup by asset for provenance checks.
    bank_by_asset = {b["asset"].lower(): b for b in banks.values()}
    seen_files: dict[str, str] = {}
    for m in manifest["entries"]:
        uid = m["waveUid"]
        check(f"manifest {uid}: provenance fields",
              bool(m.get("bank")) and bool(m.get("asset")) and bool(m.get("pak"))
              and isinstance(m.get("waveIndex"), int) and bool(m.get("wave")))
        check(f"manifest {uid}: sha", isinstance(m.get("sha256"), str) and len(m["sha256"]) == 64)
        path = ROOT / m["file"]
        check(f"manifest {uid}: file exists", path.exists(), m["file"])
        if path.exists():
            check(f"manifest {uid}: file size", path.stat().st_size == m["bytes"],
                  (path.stat().st_size, m["bytes"]))
            check(f"manifest {uid}: file hash", sha(path.read_bytes()) == m["sha256"])
        check(f"manifest {uid}: codec", m["codec"] == "uADPCM4Bit")
        check(f"manifest {uid}: rate/channels",
              m["sampleRate"] in (36000, 48000) and m["channels"] in (1, 2))
        check(f"manifest {uid}: samples/duration",
              m["samples"] > 0 and abs(m["samples"] / m["sampleRate"]
                                       - m.get("durationSeconds", 0)) < 1e-6)
        bank = bank_by_asset.get(m["asset"].lower())
        check(f"manifest {uid}: bank exists", bank is not None)
        if bank:
            check(f"manifest {uid}: bank sha", bank.get("bankSha256") == m.get("bankSha256"))
            wave = next((w for w in bank["waves"] if w["index"] == m["waveIndex"]), None)
            check(f"manifest {uid}: bank wave exists", wave is not None)
            if wave:
                check(f"manifest {uid}: wave name/dataStart/dataLength",
                      wave["name"] == m["wave"] and wave["dataStart"] == m["dataStart"]
                      and wave["dataLength"] == m["dataLength"])
                check(f"manifest {uid}: bank loop flag", bool(wave.get("loop")) == m["loop"])
        if m["loop"]:
            check(f"manifest {uid}: loop sanity",
                  m["loopStart"] == 0 and m["loopEnd"] == m["samples"], (m["loopStart"], m["loopEnd"], m["samples"]))
        else:
            check(f"manifest {uid}: one-shot loop fields",
                  m["loopStart"] == 0 and m["loopEnd"] is None)
        check(f"manifest {uid}: source", m["source"] in ("decoded", "existing-decoded"))
        check(f"manifest {uid}: finite bytes", m["bytes"] > 44)
        if path.exists():
            prev = seen_files.get(m["file"])
            check(f"manifest {uid}: no conflicting file hash", prev in (None, m["sha256"]),
                  (prev, m["sha256"]))
            seen_files[m["file"]] = m["sha256"]

    # No duplicate UID mapped to different hashes.
    uid_hashes: dict[str, set[str]] = {}
    for m in manifest["entries"]:
        uid_hashes.setdefault(m["waveUid"], set()).add(m["sha256"])
    check("no duplicate UID hash conflict", all(len(v) == 1 for v in uid_hashes.values()))

    # --------------------------------------------------- decode determinism
    if not args.quick:
        pak_entries = {p: {e["path"].lower(): e for e in pak_index(GAME / p)["entries"]}
                       for p in ("root.pak", "root_streaming.pak")}
        bank_cache: dict[str, bytes] = {}
        for m in manifest["entries"]:
            key = m["asset"].lower()
            pak_name = m["pak"]
            if key not in bank_cache:
                entry = pak_entries[pak_name][key]
                bank_cache[key] = decode_pak_asset(GAME / pak_name, entry["logical_bytes"], entry)
            data = bank_cache[key]
            payload = data[m["dataStart"]:m["dataStart"] + m["dataLength"]]
            first, _ = decode_adpcm(payload, m["channels"], m["samples"])
            second, _ = decode_adpcm(payload, m["channels"], m["samples"])
            h1 = sha(wav_bytes(first, m["channels"], m["sampleRate"]))
            h2 = sha(wav_bytes(second, m["channels"], m["sampleRate"]))
            check(f"manifest {m['waveUid']}: decode run 1 == run 2", h1 == h2)
            check(f"manifest {m['waveUid']}: decode == stored file", h1 == m["sha256"],
                  (h1, m["sha256"]))

    # ------------------------------------------------------------- contract
    decoded_events = [e for e in events if e["status"] == "decoded"]
    check("contract event count", len(contract["events"]) == len(decoded_events),
          (len(contract["events"]), len(decoded_events)))
    check("contract unsupported count",
          len(contract["unsupported"]) == len(events) - len(decoded_events))
    check("contract groups",
          set(contract["groups"]) == {"ui", "race", "powerup", "engine", "tyre",
                                      "collision", "music", "ambience"})
    for name, entry in contract["events"].items():
        check(f"contract {name}: variants", bool(entry["variants"]))
        check(f"contract {name}: provisional priority", entry["priorityProvisional"] is True)
        for v in entry["variants"]:
            check(f"contract {name}: file exists", (ROOT / v["file"]).exists(), v["file"])
            check(f"contract {name}: rate positive", isinstance(v["rate"], (int, float)) and v["rate"] > 0)
            check(f"contract {name}: gain finite or provisional",
                  (v["gainLinear"] is None and v["gainProvisional"]) or
                  (isinstance(v["gainLinear"], (int, float)) and math.isfinite(v["gainLinear"])))
            check(f"contract {name}: loop end",
                  (v["loop"] and v["loopEnd"] is not None) or
                  (not v["loop"] and v["loopEnd"] is None))
    for name, entry in contract["unsupported"].items():
        check(f"contract unsupported {name}: typed", entry["status"] in ("decodable", "unsupported")
              and (entry.get("reason") is not None or entry["status"] == "decodable"))

    # --------------------------------------------------------- cross-checks
    model_path = OUT / "tyre-collision-model.json"
    if model_path.exists():
        model = json.loads(model_path.read_text(encoding="utf-8"))
        model_waves = {}
        for bank in model["banks"].values():
            for w in bank["waves"]:
                if w.get("wavSha256"):
                    model_waves[(bank["bankName"], w["name"])] = w
        compared = 0
        for m in manifest["entries"]:
            key = (m["bank"], m["wave"])
            if key in model_waves:
                compared += 1
                w = model_waves[key]
                check(f"cross-check {m['waveUid']}: tyre/collision hash",
                      w["wavSha256"] == m["sha256"], (w["wavSha256"], m["sha256"]))
                check(f"cross-check {m['waveUid']}: tyre/collision bytes",
                      w["wavBytes"] == m["bytes"], (w["wavBytes"], m["bytes"]))
        check("cross-check at least 50 reused waves", compared >= 50, compared)

    # ------------------------------------------------------------- summary
    passed = sum(1 for c in CHECKS if c["ok"])
    failed = [c for c in CHECKS if not c["ok"]]
    result = {
        "generatedBy": "probes/audio/verify_audio_catalog.py",
        "checks": len(CHECKS), "passed": passed, "failed": len(failed),
        "failures": failed[:50],
        "manifest": {"entries": len(manifest["entries"]),
                     "bytes": manifest["bytes"], "counts": manifest["counts"]},
        "events": catalog["eventSummary"],
        "banks": bank_summary,
    }
    (OUT / "audio-catalog-verify.json").write_text(json.dumps(result, indent=1) + "\n",
                                                   encoding="utf-8")
    print(json.dumps({k: result[k] for k in ("checks", "passed", "failed")}, indent=1))
    print(json.dumps(result["manifest"], indent=1))
    if failed:
        for item in failed[:20]:
            print("FAIL", item["name"], item.get("detail"))
        raise SystemExit(1)
    print("audio-catalog-verify: PASS")


if __name__ == "__main__":
    main()
