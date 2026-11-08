"""(DMGV1) Read-only extraction of the retail damage rules used by the visual verdict.

Inputs (read-only, never modified):
  ``_work/powerups/rldatabase.xt``  (decoded ``\\gamedata\\xt\\rldatabase.xt``)
  ``_work/powerups/amax.xt``       (decoded ``\\gamedata\\xt\\amax.bin``)

The decoder is the committed ``probes/powerups/tools/xt_decode.py``; this module
only selects the damage-related records and prints the exact field values with
their record id, type and field offset. No value is inferred or invented.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "probes" / "powerups" / "tools"))
import xt_decode  # noqa: E402


def value(doc, key):
    entry = doc.get(key)
    if not isinstance(entry, dict):
        return None
    if "atom" in entry:
        return entry.get("value", entry.get("label"))
    if "label" in entry:
        return entry["label"]
    if "struct" in entry:
        return entry["struct"]
    return {k: v for k, v in entry.items() if k not in ("atom",)}


def flat_fields(flask, type_name):
    ti = next((i for i in range(len(flask.types)) if flask.type_name(i) == type_name), None)
    if ti is None:
        return None, []
    return ti, [dict(name=f["name"], offset=f["offset"], behaviour=f["behaviour"],
                     array=f["array"]) for f in flask.all_fields(ti)]


def dump_records(flask, type_name, wanted=None):
    out = []
    for ri in range(len(flask.records)):
        if flask.type_name(flask.record_type(ri)) != type_name:
            continue
        try:
            doc = flask.decode_record(ri)
        except Exception as exc:  # noqa: BLE001 - the decoder is authoritative
            out.append({"recordIndex": ri, "recordId": flask.record_id(ri),
                        "decodeError": str(exc)})
            continue
        if wanted is not None and not wanted(doc):
            continue
        out.append({"recordIndex": ri, "recordId": flask.record_id(ri), "fields": doc})
    return out


def main() -> None:
    rld = xt_decode.load(ROOT / "_work" / "powerups" / "rldatabase.xt")
    amax = xt_decode.load(ROOT / "_work" / "powerups" / "amax.xt")

    result = {"source": {}, "schemas": {}, "records": {}}
    result["source"]["rldatabase"] = {"records": len(rld.records), "types": len(rld.types)}
    result["source"]["amax"] = {"records": len(amax.records), "types": len(amax.types)}

    for type_name in ("DamageParameters", "DamageSystem", "HealthLevelZone",
                      "VehicleHealthGroup", "DamageFilter", "ImpactType",
                      "LandingType", "GhostTimeAfterSpawnParameters"):
        ti, fields = flat_fields(rld, type_name)
        if ti is not None:
            result["schemas"][type_name] = {"typeIndex": ti, "fields": fields}
        result["records"][type_name] = dump_records(rld, type_name)

    # AmaxVehicle: only the roster-relevant identity + health group + weight class.
    ti, fields = flat_fields(amax, "AmaxVehicle")
    result["schemas"]["AmaxVehicle"] = {"typeIndex": ti, "fields": fields}
    vehicles = []
    for ri in range(len(amax.records)):
        if amax.type_name(amax.record_type(ri)) != "AmaxVehicle":
            continue
        try:
            doc = amax.decode_record(ri)
        except Exception as exc:  # noqa: BLE001
            vehicles.append({"recordIndex": ri, "decodeError": str(exc)})
            continue
        vehicles.append({
            "recordIndex": ri,
            "recordId": amax.record_id(ri),
            "name": value(doc, "Name"),
            "healthGroup": value(doc, "HealthGroup"),
            "weightClass": value(doc, "weightClass"),
            "maxHealth": value(doc, "MaxHealth"),
            "dynamics": doc.get("dynamics"),
        })
    result["amaxVehicles"] = vehicles

    out = ROOT / "_work" / "damage-visuals" / "rules.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, indent=1, default=str) + "\n", encoding="utf-8")

    # Short console summary (the JSON above is the artifact).
    for type_name, records in result["records"].items():
        print(f"{type_name:28s} records={len(records)}")
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
