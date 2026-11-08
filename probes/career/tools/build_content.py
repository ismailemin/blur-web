"""Build the playable-content descriptor used by the career reachability check.

Reads only committed/local artifacts:
  * `probes/e1-drive/cars/roster.json` (the 25-car drive roster),
  * `_work/e1-drive/{sprint,sprint-lap,amboy/layout,gracia/layout}.json`
    (the four proven courses),
  * `game-data/Blur/cache/gamedata.pak` -> `amax.bin` for `AmaxVehicle.class`.

The mode support table is a declaration with explicit evidence and an exact
reason for every mode that is not implemented. It is not inferred from the
manifest. Output: `_work/career/content.json`.
"""
from __future__ import annotations

import hashlib
import json
import sys
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "probes" / "career" / "tools"))

from inspect_asset_layout import pak_index  # noqa: E402
from xt_decode import Flask  # noqa: E402

PAK = ROOT / "game-data" / "Blur" / "cache" / "gamedata.pak"
AMAX_PATH = "\\gamedata\\xt\\amax.bin"


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def read_entry(index: dict, path: str) -> bytes:
    row = next(r for r in index["entries"] if r["path"].lower() == path.lower())
    with PAK.open("rb") as stream:
        stream.seek(row["offset"])
        return zlib.decompress(stream.read(row["stored_bytes"]))


def vehicle_classes() -> dict:
    amax = Flask(read_entry(pak_index(PAK), AMAX_PATH))
    by_name = {}
    by_rp_id = {}
    for i, rec in enumerate(amax.records):
        if amax.type_name(amax.record_type(i)) == "AmaxVehicle":
            d = amax.decode_record(i)
            name = (d.get("Name") or {}).get("value")
            cls = (d.get("class") or {}).get("label") if isinstance(d.get("class"), dict) else d.get("class")
            by_name[name] = cls
            dynamics = d.get("dynamics")
            if dynamics and dynamics.get("refId") is not None:
                by_rp_id[dynamics["refId"]] = {"name": name, "class": cls}
    return by_name, by_rp_id


def layout(path: Path, course_id: str, mode: str, level: str) -> dict:
    d = json.loads(path.read_text(encoding="utf-8"))
    course = d["course"]
    laps = course.get("laps") if mode == "lap" else None
    return {
        "id": course_id,
        "mode": mode,
        "laps": laps,
        "pointToPoint": mode != "lap",
        "lengthMetres": course["lengthMetres"],
        "sampleCount": course["sampleCount"],
        "source": str(path.relative_to(ROOT)).replace("\\", "/"),
        "sourceSha256": sha256_file(path),
        "layoutHash": d["hash"],
        "level": level,
    }


def main() -> int:
    by_name, by_rp_id = vehicle_classes()
    roster = json.loads((ROOT / "probes" / "e1-drive" / "cars" / "roster.json").read_text(encoding="utf-8"))
    cars = []
    missing_class = []
    for car in roster["cars"]:
        cls = by_name.get(car["name"])
        identity = None
        if cls is None:
            identity = by_rp_id.get(car["recordId"])
            cls = identity["class"] if identity else None
        if cls is None:
            missing_class.append(car["name"])
        cars.append({
            "slug": car["slug"],
            "name": car["name"],
            "recordId": car["recordId"],
            "recordIndex": car["recordIndex"],
            "class": cls,
            "classSource": "AmaxVehicle.name" if by_name.get(car["name"]) is not None
            else ("AmaxVehicle.dynamics -> RP_CarDynamics id" if identity else None),
            "amaxVehicleName": identity["name"] if identity else None,
            "classReason": None if cls else "no AmaxVehicle name or dynamics handle resolved",
        })

    maps = {
        "usa_la_river": {
            "mapId": "river",
            "courses": [
                layout(ROOT / "_work" / "e1-drive" / "sprint.json", "310m", "sprint", "usa_la_river"),
                layout(ROOT / "_work" / "e1-drive" / "sprint-lap.json", "lap", "lap", "usa_la_river"),
            ],
            "freeRoam": True,
            "multiplayer": True,
            "powerups": ["bomb", "shield", "repair", "nitrous", "shock", "blindfire", "shunt", "barge"],
            "evidence": "probes/e1-drive/README.md modes; _work/e1-drive layouts",
        },
        "usa_amboy": {
            "mapId": "amboy",
            "courses": [layout(ROOT / "_work" / "e1-drive" / "amboy" / "layout.json", "amboy", "sprint", "usa_amboy")],
            "freeRoam": False,
            "multiplayer": True,
            "powerups": [],
            "evidence": "probes/e1-drive/README.md map package; point-to-point layout only",
        },
        "spa_barcelona_gracia": {
            "mapId": "gracia",
            "courses": [layout(ROOT / "_work" / "e1-drive" / "gracia" / "layout.json", "gracia", "sprint", "spa_barcelona_gracia")],
            "freeRoam": False,
            "multiplayer": True,
            "powerups": [],
            "evidence": "probes/e1-drive/README.md map package; point-to-point layout only",
        },
    }
    for map_id, entry in maps.items():
        entry["lapCourses"] = [c for c in entry["courses"] if c["mode"] == "lap"]

    content = {
        "kind": "blur.career.content",
        "version": 1,
        "scope": {
            "playableOnly": True,
            "retailParity": False,
            "note": "Describes what the browser build can actually load today, not what the "
                    "readers can decode. Every entry names its evidence file or gives a reason.",
        },
        "maps": maps,
        "modes": {
            "street-race": {
                "implemented": True,
                "variants": ["sprint", "lap"],
                "opponents": "host-simulated AI in the multiplayer slice (0-3); single-player AI is not integrated",
                "source": "probes/e1-drive/README.md; FULL_GAME.md M1/M2 baseline",
            },
            "destruction": {
                "implemented": False,
                "reason": "no destruction mode, wave spawner or damage model is integrated in e1-drive",
                "source": "FULL_GAME.md M2 'damage/respawn in flight'; probes/e1-drive README lists sprint/lap/free only",
            },
            "checkpoint": {
                "implemented": False,
                "reason": "no checkpoint-time mode is integrated; the sprint checkpoints are ordered gates with no clock award",
                "source": "probes/e1-drive README; race-rules covers gates, not checkpoint time",
            },
            "boss-battle": {
                "implemented": False,
                "reason": "no boss battle (minder/boss distance and wreck rules) is integrated",
                "source": "FULL_GAME.md; race-rules mode list excludes boss battle",
            },
            "fan-demand": {
                "implemented": False,
                "reason": "not present in singleplayer.bin and not integrated",
                "source": "career.json summary.eventsByMode has no fan-demand event",
            },
        },
        "cars": cars,
        "classes": sorted({c["class"] for c in cars if c["class"]}),
        "ai": {
            "maxOpponents": 3,
            "source": "FULL_GAME.md baseline: '2 humans + 0-3 host-simulated AI'",
        },
        "demands": {
            "note": "Whether a boss demand unit can be produced by the current build. Derived "
                    "units are computed by the career rules from event states; external units "
                    "need gameplay telemetry that e1-drive does not emit for career events.",
            "producible": [
                "fans", "events", "fan-pars", "fan-runs", "lights", "events-won",
                "distinct-cars", "speed-threshold", "events-without-repair-or-respawn",
            ],
            "notProducible": [
                "powerup-uses", "shield-uses", "full-shocks-evaded", "stopwatches",
                "seconds", "combo", "fan-demands", "fan-run", "cars", "wrecks",
                "barge-hits", "multi-barge-hits", "opponents-shocked", "drift-score",
                "weapon-defences", "triple-nitros", "forward-mine-hits", "nitro-rams",
                "destruction-bonus-hits", "cars-and-win", "shield-mines", "bolt-hits",
                "mine-hits", "events-in-vehicle", "reverse-bolt-hits",
            ],
        },
        "rosterMissingClasses": missing_class,
    }
    out = ROOT / "_work" / "career" / "content.json"
    text = json.dumps(content, indent=1, ensure_ascii=False)
    out.write_text(text, encoding="utf-8")
    print(f"wrote {out} sha256:{hashlib.sha256(text.encode('utf-8')).hexdigest()}")
    print("cars", len(cars), "classes", content["classes"], "missing", missing_class)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
