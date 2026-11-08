#!/usr/bin/env python3
"""Build `probes/map-laps/data/remaining-paths.json`: one verdict per remaining
map-batch level.

The document is a summary, not a new path model. It reads only committed data:

  _work/map-batch/<level>/path.json          committed draw-covered / collision path
  probes/map-laps/data/<mapId>-path.json     committed collision-clear path (if any)
  _work/map-laps/<mapId>/blocked.json        typed blocker (if any)
  probes/map-pipeline/data/map-decisions.json  the map-pipeline decision and its
                                               draw/collision path lengths

Verdicts:

  path         a committed `*-path.json` exists and is the authority
  blocked      no path exists; `blocked.json` records the stage and the exact
               blocked samples. The reason is copied verbatim, never invented.
  unsupported  the level is out of scope for a sprint path (showroom), with the
               committed map-pipeline blocker as the source

Run:

    python probes/map-laps/tools/build_remaining_paths.py
    python probes/map-laps/tools/build_remaining_paths.py --check
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "probes/map-laps/tools"))

import build_batch_paths as bb  # noqa: E402  (read-only reuse of the registry)

OUT = "probes/map-laps/data/remaining-paths.json"
DECISIONS = "probes/map-pipeline/data/map-decisions.json"

# The twelve map-batch levels this summary covers. `showroom` is listed here so
# its `unsupported` verdict is recorded, not omitted.
LEVELS = [
    ("hackney", "uk_london_hackney"),
    ("dumbo", "usa_ny_dumbo"),
    ("highrise", "usa_la_multiplayer_highrise"),
    ("shutoko", "jpn_tokyo_shutoko"),
    ("brighton", "uk_brighton"),
    ("sausalito", "usa_sanfran_sausalito"),
    ("russianhill", "usa_sanfran_russianhill"),
    ("oval", "spa_barcelona_oval"),
    ("amboy-mp", "usa_amboy_multiplayer"),
    ("downtown-mp", "usa_la_downtown_multiplayer"),
    ("bowl", "spa_barcelona_bowl_multiplayer"),
    ("showroom", "showroom"),
]


def load_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def file_sha256(path):
    return "sha256:" + hashlib.sha256(Path(path).read_bytes()).hexdigest()


def canonical_hash(doc):
    body = {k: v for k, v in doc.items() if k != "hash"}
    text = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()


def num(value, nd=6):
    if value is None:
        return None
    value = float(value)
    rounded = round(value, nd)
    if rounded == 0:
        return 0
    if rounded == int(rounded) and abs(rounded) < 1e15:
        return int(rounded)
    return rounded


def decisions_by_level():
    doc = load_json(ROOT / DECISIONS)
    return {row["level"]: row for row in doc["levels"]}


def build():
    decisions = decisions_by_level()
    rows = []
    counts = {"path": 0, "blocked": 0, "unsupported": 0}
    for map_id, level in LEVELS:
        batch_path = ROOT / "_work/map-batch" / level / "path.json"
        batch_doc = load_json(batch_path)
        decision = decisions[level]
        row = {
            "level": level,
            "mapId": map_id,
            "batchPathMetres": num(batch_doc["lengthM"], 6),
            "batchPathSamples": len(batch_doc["samples"]),
            "mapDecisionsDrawCoveredM": num(decision["paths"]["drawCoveredM"], 6),
            "mapDecisionsCollisionM": num(decision["paths"]["collisionM"], 6),
            "mapDecisionsVerdict": decision["verdict"],
        }

        if map_id in bb.UNSUPPORTED:
            unsupported = bb.UNSUPPORTED[map_id]
            row.update({
                "verdict": "unsupported",
                "lengthMetres": None,
                "samples": 0,
                "gateArcs": [],
                "clearanceCells": None,
                "corridorCells": None,
                "reason": unsupported["reason"],
                "unsupportedSource": unsupported["source"],
                "pathFile": None,
                "pathFileSha256": None,
                "pathContentHash": None,
            })
        else:
            cfg = bb.LEVELS[map_id]
            path_file = ROOT / cfg["out"]
            blocked_file = ROOT / "_work/map-laps" / map_id / "blocked.json"
            if path_file.exists():
                doc = load_json(path_file)
                row.update({
                    "verdict": "path",
                    "lengthMetres": doc["course"]["lengthMetres"],
                    "samples": doc["course"]["sampleCount"],
                    "gateArcs": [gate["arc"] for gate in doc["gates"]],
                    "clearanceCells": doc["source"]["clearance"]["cells"],
                    "corridorCells": doc["source"]["corridor"]["cells"],
                    "reason": ("committed collision-clear path; the committed draw "
                               "path is the corridor centre line only"),
                    "pathFile": cfg["out"],
                    "pathFileSha256": file_sha256(path_file),
                    "pathContentHash": doc["hash"],
                })
            else:
                if not blocked_file.exists():
                    raise SystemExit("%s has neither a path nor a blocked record" % map_id)
                blocked = load_json(blocked_file)
                row.update({
                    "verdict": "blocked",
                    "lengthMetres": None,
                    "samples": 0,
                    "gateArcs": [],
                    "clearanceCells": blocked.get("clearanceCells"),
                    "corridorCells": blocked.get("corridorCells"),
                    "reason": blocked["reason"],
                    "blockerStage": blocked.get("stage"),
                    "blockedSampleCount": len(blocked.get("blockedSamples", [])),
                    "blockedFile": str(blocked_file.relative_to(ROOT)).replace("\\", "/"),
                    "pathFile": None,
                    "pathFileSha256": None,
                    "pathContentHash": None,
                })
        counts[row["verdict"]] += 1
        rows.append(row)

    doc = {
        "schema": "blur.map-laps.remaining-paths/1",
        "source": {
            "mapDecisions": {
                "path": DECISIONS,
                "bytes": (ROOT / DECISIONS).stat().st_size,
                "sha256": file_sha256(ROOT / DECISIONS),
            },
            "builder": "probes/map-laps/tools/build_batch_paths.py",
            "note": ("lengths are the committed documents; blocked reasons are copied "
                     "from _work/map-laps/<mapId>/blocked.json, never paraphrased"),
        },
        "scope": {
            "collisionOnly": True,
            "drawGeometryRead": False,
            "rendererClaim": False,
            "vehiclePhysics": False,
            "gameRun": False,
            "pathDriven": False,
            "note": ("a data summary only; a path is not a playable map and no lap "
                     "was driven"),
        },
        "levels": rows,
        "summary": {"counts": counts, "levelCount": len(rows)},
    }
    doc["hash"] = canonical_hash(doc)
    return doc


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=None,
                    help="override the output path (used by the verifier)")
    ap.add_argument("--check", action="store_true",
                    help="compare the generated document with the committed file")
    args = ap.parse_args(argv)
    doc = build()
    text = json.dumps(doc, indent=1, ensure_ascii=False) + "\n"
    encoded = text.encode("utf-8")
    out = args.out if args.out else ROOT / OUT
    if args.check:
        if not out.exists():
            print("MISSING %s" % out)
            return 1
        if out.read_bytes() != encoded:
            print("STALE %s" % out)
            return 1
        print("OK %s" % out)
        return 0
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(encoded)
    try:
        output = str(out.relative_to(ROOT)).replace("\\", "/")
    except ValueError:
        output = str(out)
    print(json.dumps({
        "output": output,
        "bytes": len(encoded),
        "hash": doc["hash"],
        "counts": doc["summary"]["counts"],
        "levels": [{"level": row["level"], "verdict": row["verdict"],
                    "lengthMetres": row["lengthMetres"]} for row in doc["levels"]],
    }, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
