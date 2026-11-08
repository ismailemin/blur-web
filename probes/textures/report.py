#!/usr/bin/env python3
"""Print the Markdown tables used by ``docs/work/analysis/texture-coverage.md``.

Reads only ``_work/textures/coverage.json`` and ``_work/textures/<map>/decode.json``
so every number in the document can be regenerated with one command. Nothing is
written.
"""
from __future__ import annotations

import argparse
import json
import statistics
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT_ROOT = ROOT / "_work/textures"
SHORT = {"usa_amboy": "amboy", "spa_barcelona_gracia": "gracia"}


def load(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def fmt_bytes(value: int) -> str:
    return "{:,}".format(value)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--section", default="all",
                        choices=("all", "coverage", "size", "alpha", "decal", "runtime", "bytes"))
    args = parser.parse_args()
    coverage = load(OUT_ROOT / "coverage.json")
    decodes = {level: load(OUT_ROOT / short / "decode.json") for level, short in SHORT.items()}

    def show(name):
        return args.section in ("all", name)

    if show("coverage"):
        print("## Coverage\n")
        print("| map | draws now | tri now | size fix | alpha fix | decal | runtime | all identity-resolved |")
        print("|---|---:|---:|---:|---:|---:|---:|---:|")
        for level, row in coverage["maps"].items():
            cov = row["coverage"]
            print("| `%s` | %d / %d (%.1f%%) | %s / %s (%.1f%%) | +%d / +%s | +%d / +%s | %d | %d | %d / %d (%.1f%%) |"
                  % (level, cov["now"]["draws"], row["totals"]["draws"],
                     cov["now"]["drawFraction"] * 100,
                     fmt_bytes(cov["now"]["triangles"]), fmt_bytes(row["totals"]["triangles"]),
                     cov["now"]["triangleFraction"] * 100,
                     row["fixA"]["unlockedDraws"], fmt_bytes(row["fixA"]["unlockedTriangles"]),
                     row["fixB"]["allocatedDraws"], fmt_bytes(row["fixB"]["allocatedTriangles"]),
                     row["decal"]["draws"], row["runtime"]["draws"],
                     cov["afterSizeAndAlpha"]["draws"], row["totals"]["draws"],
                     cov["afterSizeAndAlpha"]["drawFraction"] * 100))
        print()

    if show("size"):
        print("## Size-blocked sources\n")
        print("| source | name | size | format | mips | blob B | mip0 RGBA B | alpha | draws | tri | verdict |")
        print("|---|---|---|---|---:|---:|---:|---|---:|---:|---|")
        for level, row in coverage["maps"].items():
            for tex in row["fixA"]["textures"]:
                verdict = "bindable now" if tex["alphaOpaque"] else "alpha rule"
                print("| `%s` | `%s` | %dx%d | %s | %d | %s | %s | %d..%d | %d | %s | **%s** |"
                      % (tex["id"], tex["name"], tex["width"], tex["height"], tex["format"],
                         tex["levels"], fmt_bytes(tex["encodedMipChainBytes"]),
                         fmt_bytes(tex["rgbaBytes"]), tex["alphaMin"], tex["alphaMax"],
                         tex["unlockedDraws"], fmt_bytes(tex["unlockedTriangles"]), verdict))
        print()

    if show("alpha"):
        print("## Alpha-rule sources\n")
        print("| map | shape | sources | draws | tri | mip0 B | derived chain B |")
        print("|---|---|---:|---:|---:|---:|---:|")
        for level, row in coverage["maps"].items():
            for shape, group in row["fixB"]["shapes"].items():
                if not group["sources"]:
                    continue
                print("| `%s` | `%s` | %d | %d | %s | %s | %s |"
                      % (level, shape, group["sources"], group["draws"],
                         fmt_bytes(group["triangles"]),
                         fmt_bytes(group["bytes"]["uniqueMip0Bytes"]),
                         fmt_bytes(group["bytes"]["derivedChainBytes"])))
        print()
        for level, row in coverage["maps"].items():
            rows = [tex for tex in row["fixB"]["textures"] if tex["shape"] == "cutout"]
            if not rows:
                continue
            kept = [1 - tex["alpha"]["below128Fraction"] for tex in rows]
            print("- `%s` cutout set: %d sources, alpha 0.5 test keeps %.1f%%..%.1f%% "
                  "of texels per image (median %.1f%%)."
                  % (level, len(rows), min(kept) * 100, max(kept) * 100,
                     statistics.median(kept) * 100))
            translucent = [tex for tex in row["fixB"]["textures"]
                           if tex["shape"] == "translucent-no-background"]
            if translucent:
                print("- `%s` no-background translucent set: %s"
                      % (level, ", ".join("`%s` %dx%d (alpha %d..%d, %d draws)"
                                          % (tex["name"], tex["width"], tex["height"],
                                             tex["alpha"]["min"], tex["alpha"]["max"],
                                             tex["draws"])
                                          for tex in translucent[:12])))
                if len(translucent) > 12:
                    print("  and %d more." % (len(translucent) - 12))
        print()

    if show("decal"):
        print("## Decal (`Racification*`) texture sources\n")
        print("| map | name | size | format | mip0 RGBA B | alpha | draws | tri |")
        print("|---|---|---|---|---:|---|---:|---:|")
        for level, row in coverage["maps"].items():
            for tex in row["decal"]["textures"]:
                print("| `%s` | `%s` | %dx%d | %s | %s | %d..%d | %d | %s |"
                      % (level, tex["name"], tex["width"], tex["height"], tex["format"],
                         fmt_bytes(tex["rgbaBytes"]), tex["alphaMin"], tex["alphaMax"],
                         tex["draws"], fmt_bytes(tex["triangles"])))
            print("| `%s` | **total %d sources** | | | **%s** | | **%d** | **%s** |"
                  % (level, row["decal"]["bytes"]["sources"],
                     fmt_bytes(row["decal"]["bytes"]["mip0Bytes"]), row["decal"]["draws"],
                     fmt_bytes(row["decal"]["triangles"])))
        print()

    if show("runtime"):
        print("## Runtime-only albedo draws\n")
        print("| map | section | draw | primitive | effect | material row | g_tAlbedo type | runtime refs | tri |")
        print("|---|---|---:|---:|---|---:|---:|---|---:|")
        for level, row in coverage["maps"].items():
            tris = {}
            bindings = load(ROOT / "_work/map-slice" / (SHORT[level] + "-textures") / "bindings.json")
            for draw in bindings["draws"]:
                tris[(draw["section"], draw["drawIndex"])] = draw["triangleCount"]
            for entry in row["runtime"]["proof"]["draws"]:
                refs = ", ".join("%d:%d" % (ref["index"], ref["listIndex"])
                                 for ref in entry["runtimeListRefs"])
                print("| `%s` | `%s` | %d | %d | `%s` | %d | %d | %s | %d |"
                      % (level, entry["section"], entry["drawIndex"], entry["primitiveIndex"],
                         entry["effect"], entry["materialRow"], entry["elementType"], refs,
                         tris.get((entry["section"], entry["drawIndex"]), 0)))
        print()

    if show("bytes"):
        print("## Byte totals\n")
        print("| map | now unique mip0 | fixA mip0 | fixA chain | fixB mip0 | fixB chain | decal mip0 | all unique mip0 | all chain |")
        print("|---|---:|---:|---:|---:|---:|---:|---:|---:|")
        for level, row in coverage["maps"].items():
            print("| `%s` | %s | %s | %s | %s | %s | %s | %s | %s |"
                  % (level, fmt_bytes(row["bytes"]["bindableNow"]["uniqueMip0Bytes"]),
                     fmt_bytes(row["fixA"]["bytes"]["uniqueMip0Bytes"]),
                     fmt_bytes(row["fixA"]["bytes"]["derivedChainBytes"]),
                     fmt_bytes(row["fixB"]["bytes"]["uniqueMip0Bytes"]),
                     fmt_bytes(row["fixB"]["bytes"]["derivedChainBytes"]),
                     fmt_bytes(row["decal"]["bytes"]["mip0Bytes"]),
                     fmt_bytes(row["bytes"]["allIdentityResolved"]["uniqueMip0Bytes"]),
                     fmt_bytes(row["bytes"]["allIdentityResolved"]["derivedChainBytes"])))
        print()
        for level, row in coverage["maps"].items():
            print("- `%s` texture sources now %d (+%d size, +%d alpha), encoded blob bytes now %s."
                  % (level, row["bytes"]["bindableNow"]["sources"],
                     row["fixA"]["bytes"]["sources"], row["fixB"]["bytes"]["sources"],
                     fmt_bytes(row["bytes"]["bindableNow"]["encodedBlobBytes"])))
        print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
