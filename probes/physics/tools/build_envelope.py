"""Build the per-car physics envelope manifest (PHYS1).

Usage
-----
    python probes/physics/tools/build_envelope.py [--out DIR]

Default output: ``_work/physics/envelope.json``.  The builder never writes
outside ``_work/physics`` (or the directory passed with ``--out``) and never
modifies another probe's inputs.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve()
ROOT = HERE.parents[3]
sys.path.insert(0, str(HERE.parents[1] / "lib"))

from envelope import (  # noqa: E402
    FIXED_ENVELOPE,
    build_manifest,
    canonical,
    rel,
    sha256_bytes,
)


def write_text(path: Path, text: str):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")


def table(manifest) -> str:
    lines = []
    header = ("| car | body L (m) | body W (m) | body H (m) | wheelbase (m) | "
              "track F/R (m) | tyre r (m) | dL vs 2.98 | dW vs 1.68 | dH vs 1.35 |")
    lines.append(header)
    lines.append("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")
    for row in manifest["summary"]["integrated"]:
        delta = row["delta"] or {}
        lines.append(
            "| {name} | {L:.3f} | {W:.3f} | {H:.3f} | {wb:.3f} | {tf:.3f} / {tr:.3f} | "
            "{r:.3f} | {dL:+.3f} | {dW:+.3f} | {dH:+.3f} |".format(
                name=row["name"], L=row["bodyLength"], W=row["bodyWidth"],
                H=row["bodyHeight"], wb=row["wheelbase"], tf=row["trackFront"],
                tr=row["trackRear"], r=row["tyreRadiusFront"],
                dL=delta.get("length", 0.0), dW=delta.get("width", 0.0),
                dH=delta.get("height", 0.0)))
    batch2 = [c for c in manifest["cars"] if c["integrationStage"] == "staged-batch2"]
    lines.append("")
    lines.append("| staged batch 2 | body L | body W | body H | wheelbase | track F/R | tyre r | "
                 "dL | dW | dH |")
    lines.append("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")
    for car in batch2:
        b = car["bodyEnvelope"]
        d = car["deltaVsFixed"]["bodyVsFixed"]
        v = {k: x["value"] for k, x in car["physics"]["values"].items()}
        lines.append(
            "| {name} | {L:.3f} | {W:.3f} | {H:.3f} | {wb:.3f} | {tf:.3f} / {tr:.3f} | "
            "{r:.3f} | {dL:+.3f} | {dW:+.3f} | {dH:+.3f} |".format(
                name=car["name"], L=b["length"], W=b["width"], H=b["height"],
                wb=v["geometry.wheelBase"], tf=v["geometry.trackWidthFront"],
                tr=v["geometry.trackWidthRear"], r=v["tyres.frontTyres.radius"],
                dL=d["length"], dW=d["width"], dH=d["height"]))
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=str(ROOT / "_work/physics"))
    parser.add_argument("--log", default=str(ROOT / "_work/logs/physics/build.log"))
    args = parser.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    manifest = build_manifest()
    payload = json.dumps(manifest, indent=2, sort_keys=True, ensure_ascii=True,
                         allow_nan=False) + "\n"
    target = out / "envelope.json"
    write_text(target, payload)
    write_text(out / "tables.md", table(manifest))

    summary = manifest["summary"]["integrated"]
    scope = manifest["scope"]
    fixed = manifest["fixedEnvelope"]
    report = [
        f"manifest {rel(target)} bytes {target.stat().st_size}",
        f"sha256 {sha256_bytes(payload.encode('utf-8'))}",
        f"contentSha256 {manifest['contentSha256']}",
        f"records {scope['records']} integrated {scope['integratedCars']} "
        f"stagedBatch2 {scope['stagedBatch2Cars']}",
        f"bodyAabb {scope['carsWithBodyAabb']} absent {scope['carsWithoutBodyAabb']}",
        f"schema leaves {manifest['schema']['leafCount']} "
        f"geometryRelevant {manifest['schema']['counts']['geometryRelevant']} "
        f"extracted {manifest['schema']['counts']['extracted']}",
        f"fixed five-car derivation matches: {fixed['recomputedFromFiveCarRoster']['matches']}",
        f"all-62 max wheelbase {fixed['recomputedFromAll62']['maxWheelbase']} "
        f"({fixed['recomputedFromAll62']['maxWheelbaseRecord']})",
        f"all-62 max track {fixed['recomputedFromAll62']['maxTrack']} "
        f"({fixed['recomputedFromAll62']['maxTrackRecord']})",
        f"axle box outside fixed: {fixed['recomputedFromAll62']['carsWithAxleBoxOutsideFixed']} / 62",
        f"integrated rows {len(summary)}",
    ]
    for row in summary:
        d = row["delta"]
        report.append(
            "  {name}: L {L:.3f} W {W:.3f} H {H:.3f} | dL {dL:+.3f} dW {dW:+.3f} "
            "dH {dH:+.3f} m".format(name=row["name"], L=row["bodyLength"],
                                    W=row["bodyWidth"], H=row["bodyHeight"],
                                    dL=d["length"], dW=d["width"], dH=d["height"]))
    text = "\n".join(report) + "\n"
    write_text(Path(args.log), text)
    print(text, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
