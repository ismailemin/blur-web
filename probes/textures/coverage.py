#!/usr/bin/env python3
"""Per-map texture-coverage report from the extended decode.

Joins the committed MAP3/MAP5 binding manifest (per-draw material/albedo/UV0
status) with the extended decode facts from ``extract.py`` and writes
``_work/textures/coverage.json`` plus a compact terminal table.

The arithmetic is designed to be independently checkable:

* ``bindable + size + alpha - (size->alpha reclassification) + decal + runtime``
  must reconstruct the map total;
* ``bindable + newly-opaque-size + alpha`` must equal the reader's own
  "static albedo identity resolved" count (1,268 Amboy / 3,058 Gracia). That
  join is the proof that the only thing separating an identity-resolved draw from
  a bindable draw is the two decoder/state verdicts studied here.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "probes/textures"))

import bc_decode  # noqa: E402

OUT_ROOT = ROOT / "_work/textures"
SHORT = {"usa_amboy": "amboy", "spa_barcelona_gracia": "gracia"}
# Reader-reported counts from the READ1 export, re-used as an arithmetic anchor.
IDENTITY_RESOLVED = {"usa_amboy": 1268, "spa_barcelona_gracia": 3058}
TOTAL_DRAWS = {"usa_amboy": 1606, "spa_barcelona_gracia": 3580}


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path: Path, doc) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc, indent=1, ensure_ascii=False, allow_nan=False) + "\n",
                    encoding="utf-8", newline="\n")


def chain_bytes(width: int, height: int) -> int:
    """RGBA bytes of the consumer's derived full mip chain (packet-consumer.js)."""
    total = 0
    w, h = width, height
    while True:
        total += w * h * 4
        if w == 1 and h == 1:
            return total
        w = max(1, w >> 1)
        h = max(1, h >> 1)


def alpha_shape(alpha: dict) -> str:
    """Classify the alpha channel by the rule a renderer would need.

    The thresholds are stated so the verdict is checkable, not tuned:

    * ``opaque`` - every texel alpha 255; no rule needed.
    * ``cutout`` - the texture has fully transparent texels (``zeroFraction``
      >= 1 %), so the alpha channel carves a shape out of a background. A 0.5
      alpha test reproduces that shape; graded edge texels are antialiasing.
    * ``translucent-no-background`` - no fully transparent texel and a non-255
      minimum: the whole surface is see-through (net, glass, canopy), so it needs
      blending; an alpha test would either keep it all or erode it.
    * ``translucent-uniform`` - no fully transparent texel and a minimum >= 128:
      a gentle uniform transparency (blend, no test).
    """
    if alpha["alphaOpaque"]:
        return "opaque"
    if alpha["zeroFraction"] >= 0.01:
        return "cutout"
    if alpha["min"] >= 128:
        return "translucent-uniform"
    return "translucent-no-background"


def texture_bytes(index: dict, ids: set[str]) -> dict:
    """Distinct-payload byte totals for a set of texture ids."""
    rows = [index[i] for i in ids if i in index]
    by_hash = {}
    for row in rows:
        by_hash.setdefault(row["rgbaSha256"], row)
    return {
        "sources": len(rows),
        "uniquePayloads": len(by_hash),
        "mip0Bytes": sum(row["rgbaBytes"] for row in rows),
        "uniqueMip0Bytes": sum(row["rgbaBytes"] for row in by_hash.values()),
        "derivedChainBytes": sum(chain_bytes(row["width"], row["height"]) for row in by_hash.values()),
        "encodedBlobBytes": sum(row["blobBytes"] for row in rows),
        "maxDimension": max((max(row["width"], row["height"]) for row in rows), default=0),
    }


def build(level: str) -> dict:
    short = SHORT[level]
    decode = load_json(OUT_ROOT / short / "decode.json")
    bindings = load_json(ROOT / "_work/map-slice" / (short + "-textures") / "bindings.json")
    index = {row["id"]: row for row in decode["textures"]}
    draws = bindings["draws"]

    statuses = {}
    for draw in draws:
        statuses.setdefault(draw["status"], []).append(draw)

    def subset(predicate):
        rows = [draw for draw in draws if predicate(draw)]
        return {
            "draws": len(rows),
            "triangles": sum(row["triangleCount"] for row in rows),
            "textureIds": sorted({row["textureId"] for row in rows if row["textureId"]}),
        }

    bindable_now = subset(lambda d: d["status"] == "bindable-static-albedo")
    size_blocked = subset(lambda d: d["status"] == "blocked-decoder-size-limit")
    alpha_blocked = subset(lambda d: d["status"] == "blocked-alpha-rule-missing")
    decal_blocked = subset(lambda d: d["status"] == "blocked-effect-not-static-albedo")
    runtime_blocked = subset(lambda d: d["status"] == "blocked-runtime-albedo-parameter")

    # Fix A: the extension decodes every size-blocked source. A source whose
    # decoded alpha is fully opaque becomes bindable immediately; a graded-alpha
    # source moves into the alpha class instead of staying size-blocked.
    size_opaque_ids = set()
    size_alpha_ids = set()
    per_texture = {}
    for draw in draws:
        key = draw["textureId"]
        row = per_texture.setdefault(key, {"draws": 0, "triangles": 0, "sections": set()})
        row["draws"] += 1
        row["triangles"] += draw["triangleCount"]
        row["sections"].add(draw["section"])
    size_rows = []
    for texture_id in size_blocked["textureIds"]:
        row = index[texture_id]
        is_opaque = row["alpha"]["alphaOpaque"]
        (size_opaque_ids if is_opaque else size_alpha_ids).add(texture_id)
        size_rows.append({
            "id": texture_id,
            "name": row["name"],
            "width": row["width"],
            "height": row["height"],
            "format": row["formatName"],
            "levels": row["levels"],
            "encodedMipChainBytes": row["encodedMipChainBytes"],
            "rgbaBytes": row["rgbaBytes"],
            "rgbaSha256": row["rgbaSha256"],
            "alphaOpaque": is_opaque,
            "alphaMin": row["alpha"]["min"],
            "alphaMax": row["alpha"]["max"],
            "alphaDistinct": row["alpha"]["distinct"],
            "committedRejection": row["committedDecoderRejection"],
            "unlockedDraws": sum(1 for d in draws
                                 if d["status"] == "blocked-decoder-size-limit"
                                 and d["textureId"] == texture_id),
            "unlockedTriangles": sum(d["triangleCount"] for d in draws
                                     if d["status"] == "blocked-decoder-size-limit"
                                     and d["textureId"] == texture_id),
            "sections": sorted({d["section"] for d in draws
                                if d["status"] == "blocked-decoder-size-limit"
                                and d["textureId"] == texture_id}),
        })
    size_unlocked = subset(lambda d: d["status"] == "blocked-decoder-size-limit"
                          and d["textureId"] in size_opaque_ids)
    size_to_alpha = subset(lambda d: d["status"] == "blocked-decoder-size-limit"
                           and d["textureId"] in size_alpha_ids)

    # Fix B: an alpha rule covers the pre-existing alpha draws plus the
    # size-blocked sources the decode moved into the alpha class.
    alpha_ids = set(alpha_blocked["textureIds"]) | set(size_to_alpha["textureIds"])
    alpha_after = {
        "draws": alpha_blocked["draws"] + size_to_alpha["draws"],
        "triangles": alpha_blocked["triangles"] + size_to_alpha["triangles"],
        "textureIds": sorted(alpha_ids),
    }
    alpha_rows = []
    for texture_id in alpha_after["textureIds"]:
        row = index[texture_id]
        alpha_rows.append({
            "id": texture_id,
            "name": row["name"],
            "width": row["width"],
            "height": row["height"],
            "format": row["formatName"],
            "rgbaBytes": row["rgbaBytes"],
            "rgbaSha256": row["rgbaSha256"],
            "alpha": {key: row["alpha"][key] for key in
                      ("min", "max", "distinct", "zeroFraction", "opaqueFraction",
                       "below128Fraction")},
            "shape": alpha_shape(row["alpha"]),
            "draws": sum(1 for d in draws if d["textureId"] == texture_id
                         and (d["status"] == "blocked-alpha-rule-missing"
                              or (d["status"] == "blocked-decoder-size-limit"
                                  and d["textureId"] in size_alpha_ids))),
            "triangles": sum(d["triangleCount"] for d in draws if d["textureId"] == texture_id
                             and (d["status"] == "blocked-alpha-rule-missing"
                                  or (d["status"] == "blocked-decoder-size-limit"
                                      and d["textureId"] in size_alpha_ids))),
        })
    shape_of = {row["id"]: row["shape"] for row in alpha_rows}
    shapes = {}
    for shape in ("cutout", "translucent-no-background", "translucent-uniform"):
        ids = {texture_id for texture_id, value in shape_of.items() if value == shape}
        draws_for_shape = subset(lambda d: d["textureId"] in ids)
        shapes[shape] = {
            "sources": len(ids),
            "draws": draws_for_shape["draws"],
            "triangles": draws_for_shape["triangles"],
            "bytes": texture_bytes(index, ids),
            "textureIds": sorted(ids),
        }

    decal_rows = []
    for row in decode["decalTextures"]:
        decal_rows.append({
            "id": row["id"],
            "name": row["name"],
            "block": row["block"],
            "index": row["index"],
            "width": row["width"],
            "height": row["height"],
            "format": row["formatName"],
            "rgbaBytes": row["rgbaBytes"],
            "rgbaSha256": row["rgbaSha256"],
            "alphaOpaque": row["alpha"]["alphaOpaque"],
            "alphaMin": row["alpha"]["min"],
            "alphaMax": row["alpha"]["max"],
            "alphaDistinct": row["alpha"]["distinct"],
            "draws": row["draws"],
            "triangles": row["triangles"],
            "effects": row["effects"],
        })

    totals = {
        "draws": TOTAL_DRAWS[level],
        "triangles": bindings["counts"]["triangles"],
        "distinctTextureSources": bindings["counts"]["distinctTextureSources"],
    }
    arithmetic = {
        "draws": (bindable_now["draws"] + size_unlocked["draws"] + alpha_after["draws"]
                  + decal_blocked["draws"] + runtime_blocked["draws"]),
        "triangles": (bindable_now["triangles"] + size_unlocked["triangles"]
                      + alpha_after["triangles"] + decal_blocked["triangles"]
                      + runtime_blocked["triangles"]),
    }
    identity_join = (bindable_now["draws"] + size_unlocked["draws"] + alpha_after["draws"])
    if arithmetic["draws"] != totals["draws"] or arithmetic["triangles"] != totals["triangles"]:
        raise SystemExit("%s: status arithmetic does not reconstruct the draw total" % level)

    before = texture_bytes(index, set(bindable_now["textureIds"]))
    after_all = texture_bytes(index, set(bindable_now["textureIds"]) | size_opaque_ids
                              | set(alpha_after["textureIds"]))
    fix_a_bytes = texture_bytes(index, size_opaque_ids)
    fix_b_bytes = texture_bytes(index, set(alpha_after["textureIds"]))
    decal_bytes = {
        "sources": len(decal_rows),
        "uniquePayloads": len({row["rgbaSha256"] for row in decal_rows}),
        "mip0Bytes": sum(row["rgbaBytes"] for row in decal_rows),
        "derivedChainBytes": sum(chain_bytes(row["width"], row["height"]) for row in decal_rows),
        "opaqueSources": sum(1 for row in decal_rows if row["alphaOpaque"]),
    }

    # Per-section gain, for the report's "where the gain lands" table.
    sections = {}
    for draw in draws:
        row = sections.setdefault(draw["section"], {
            "draws": 0, "triangles": 0, "bindable": 0, "bindableTriangles": 0,
            "sizeUnlocked": 0, "sizeTriangles": 0, "alpha": 0, "alphaTriangles": 0,
            "decal": 0, "runtime": 0,
        })
        row["draws"] += 1
        row["triangles"] += draw["triangleCount"]
        status = draw["status"]
        if status == "bindable-static-albedo":
            row["bindable"] += 1
            row["bindableTriangles"] += draw["triangleCount"]
        elif status == "blocked-decoder-size-limit":
            if draw["textureId"] in size_opaque_ids:
                row["sizeUnlocked"] += 1
                row["sizeTriangles"] += draw["triangleCount"]
            else:
                row["alpha"] += 1
                row["alphaTriangles"] += draw["triangleCount"]
        elif status == "blocked-alpha-rule-missing":
            row["alpha"] += 1
            row["alphaTriangles"] += draw["triangleCount"]
        elif status == "blocked-effect-not-static-albedo":
            row["decal"] += 1
        elif status == "blocked-runtime-albedo-parameter":
            row["runtime"] += 1
    top_gain = sorted(sections.items(), key=lambda item: (-(item[1]["sizeUnlocked"]),
                                                          -item[1]["sizeTriangles"]))[:8]

    coverage = {
        "now": {
            "draws": bindable_now["draws"],
            "triangles": bindable_now["triangles"],
            "drawFraction": bindable_now["draws"] / totals["draws"],
            "triangleFraction": bindable_now["triangles"] / totals["triangles"],
        },
        "afterSizeFix": {
            "draws": bindable_now["draws"] + size_unlocked["draws"],
            "triangles": bindable_now["triangles"] + size_unlocked["triangles"],
        },
        "afterSizeAndAlpha": {
            "draws": identity_join,
            "triangles": (bindable_now["triangles"] + size_unlocked["triangles"]
                          + alpha_after["triangles"]),
            "drawFraction": identity_join / totals["draws"],
            "triangleFraction": (bindable_now["triangles"] + size_unlocked["triangles"]
                                 + alpha_after["triangles"]) / totals["triangles"],
        },
    }
    if IDENTITY_RESOLVED[level] != identity_join:
        raise SystemExit("%s: identity-resolved anchor %d != computed %d"
                         % (level, IDENTITY_RESOLVED[level], identity_join))

    return {
        "level": level,
        "short": short,
        "totals": totals,
        "coverage": coverage,
        "identityJoin": {
            "readerIdentityResolved": IDENTITY_RESOLVED[level],
            "bindableNow": bindable_now["draws"],
            "sizeUnlocked": size_unlocked["draws"],
            "alphaRuleRequired": alpha_after["draws"],
            "equalsReader": IDENTITY_RESOLVED[level] == identity_join,
        },
        "arithmetic": arithmetic,
        "statuses": {key: {"draws": len(value),
                           "triangles": sum(d["triangleCount"] for d in value)}
                     for key, value in statuses.items()},
        "fixA": {
            "name": "lift the 512 px / 10 mip validator bound",
            "decodedSources": len(size_rows),
            "unlockedDraws": size_unlocked["draws"],
            "unlockedTriangles": size_unlocked["triangles"],
            "reclassifiedToAlphaDraws": size_to_alpha["draws"],
            "reclassifiedToAlphaTriangles": size_to_alpha["triangles"],
            "bytes": fix_a_bytes,
            "textures": size_rows,
        },
        "fixB": {
            "name": "declare the source alpha rule (test / blend / alpha-to-coverage)",
            "allocatedDraws": alpha_after["draws"],
            "allocatedTriangles": alpha_after["triangles"],
            "bytes": fix_b_bytes,
            "textures": alpha_rows,
            "shapes": shapes,
        },
        "bytes": {
            "bindableNow": before,
            "allIdentityResolved": after_all,
        },
        "decal": {
            "draws": decal_blocked["draws"],
            "triangles": decal_blocked["triangles"],
            "effects": {effect: sum(1 for d in draws
                                    if d["status"] == "blocked-effect-not-static-albedo"
                                    and d["effect"] == effect)
                        for effect in sorted({d["effect"] for d in draws
                                              if d["status"] == "blocked-effect-not-static-albedo"})},
            "textures": decal_rows,
            "bytes": decal_bytes,
        },
        "runtime": {
            "draws": runtime_blocked["draws"],
            "triangles": runtime_blocked["triangles"],
            "proof": decode["runtimeAlbedo"],
        },
        "sections": sections,
        "topGainSections": [{"id": key, **value} for key, value in top_gain],
        "inputs": decode["inputs"],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=OUT_ROOT / "coverage.json")
    args = parser.parse_args()
    doc = {
        "schema": "blur.textures.coverage/1",
        "kind": "map-texture-coverage",
        "scope": {
            "dataOnly": True,
            "rendererChanged": False,
            "gpuClaim": False,
            "browserFrameProduced": False,
            "texturesBoundInRenderer": False,
            "alphaRuleApplied": False,
            "e1DriveChanged": False,
        },
        "decoder": {
            "committedMaxDimension": bc_decode.COMMITTED_MAX_DIMENSION,
            "committedMaxLevels": bc_decode.COMMITTED_MAX_LEVELS,
            "extendedMaxDimension": bc_decode.MAX_DIMENSION,
            "extendedMaxLevels": bc_decode.MAX_LEVELS,
        },
        "maps": {level: build(level) for level in SHORT},
    }
    write_json(args.out, doc)
    for level, row in doc["maps"].items():
        cov = row["coverage"]
        print("%-22s draws %4d/%4d (%.1f%%)  tri %6d/%6d (%.1f%%)  "
              "size+%d/%d tri  alpha+%d/%d tri  decal %d  runtime %d"
              % (level, cov["now"]["draws"], row["totals"]["draws"],
                 cov["now"]["drawFraction"] * 100,
                 cov["now"]["triangles"], row["totals"]["triangles"],
                 cov["now"]["triangleFraction"] * 100,
                 row["fixA"]["unlockedDraws"], row["fixA"]["unlockedTriangles"],
                 row["fixB"]["allocatedDraws"], row["fixB"]["allocatedTriangles"],
                 row["decal"]["draws"], row["runtime"]["draws"]))
        print("   bytes now %d -> all identity-resolved %d (mip0, unique payloads); "
              "fixA %d, fixB %d"
              % (row["bytes"]["bindableNow"]["uniqueMip0Bytes"],
                 row["bytes"]["allIdentityResolved"]["uniqueMip0Bytes"],
                 row["fixA"]["bytes"]["uniqueMip0Bytes"],
                 row["fixB"]["bytes"]["uniqueMip0Bytes"]))
    print("wrote", args.out.relative_to(ROOT).as_posix())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
