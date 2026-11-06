"""Compare the P73b before/after level-prop screenshots.

The "before" frames were captured with the committed geometry v6 (level props
diagnostic neutral albedo). The "after" frames are the same URL, tick and camera
with geometry v7 (18 level draws sample their decoded BC1 image through the real
P73a UV0 stream). This tool reports the measured pixel delta so the visual change
is evidence, not a claim.

Both sets are read-only inputs under `_work/e1-drive/`; the report is written to
`_work/e1-drive/browser-evidence-prop-textures.json` and never committed.

Usage:
    python probes/e1-drive/tools/compare_prop_captures.py
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

from PIL import Image, ImageChops

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "_work/e1-drive"
BEFORE = OUT / "before-prop"
REPORT = OUT / "browser-evidence-prop-textures.json"

PAIRS = [
    ("drive-120", "browser-corvette-zr1-stock-drive-120.png",
     "browser-corvette-zr1-stock-prop-tick120.png"),
    ("free-prop", "browser-corvette-zr1-stock-free-prop.png",
     "browser-corvette-zr1-stock-prop-free.png"),
    ("sprint-start", "browser-corvette-zr1-stock-sprint-start.png",
     "browser-corvette-zr1-stock-prop-sprint-start.png"),
    ("lap-start", "browser-corvette-zr1-stock-sprint-lap-start.png",
     "browser-corvette-zr1-stock-prop-lap-start.png"),
]


def sha256(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def compare(before: Path, after: Path) -> dict:
    if not before.is_file() or not after.is_file():
        return {"ok": False, "reason": "missing screenshot", "before": str(before), "after": str(after)}
    a = Image.open(before).convert("RGB")
    b = Image.open(after).convert("RGB")
    if a.size != b.size:
        return {"ok": False, "reason": "size differs", "beforeSize": list(a.size), "afterSize": list(b.size)}
    diff = ImageChops.difference(a, b)
    bbox = diff.getbbox()
    pixels = a.width * a.height
    changed = 0
    total = 0
    grey = diff.convert("L")
    histogram = grey.histogram()
    for value, count in enumerate(histogram):
        total += value * count
        if value > 0:
            changed += count
    return {
        "ok": True,
        "width": a.width,
        "height": a.height,
        "pixels": pixels,
        "changedPixels": changed,
        "changedFraction": round(changed / pixels, 6),
        "changedPercent": round(100 * changed / pixels, 3),
        "meanAbsoluteDifference": round(total / (pixels * 255), 6),
        "changedBBox": list(bbox) if bbox else None,
        "before": str(before.relative_to(ROOT)).replace("\\", "/"),
        "after": str(after.relative_to(ROOT)).replace("\\", "/"),
        "beforeSha256": sha256(before),
        "afterSha256": sha256(after),
        "identical": changed == 0,
    }


def main() -> None:
    rows = []
    failures = []
    for label, before_name, after_name in PAIRS:
        row = {"label": label, **compare(BEFORE / before_name, OUT / after_name)}
        rows.append(row)
        if not row.get("ok") or row.get("identical"):
            failures.append(label + ": " + str(row.get("reason") or "no pixel change"))
    evidence = {
        "mode": "prop-textures-before-after",
        "note":
            "before = geometry v6 level props diagnostic neutral albedo; after = geometry v7 18 BC1 "
            "draws sampling the P73a UV0 stream; the 4 BC3 cab draws remain diagnostic in both",
        "pairs": rows,
        "failures": failures,
        "verdict": "changed" if not failures else "failed",
    }
    REPORT.write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "report": str(REPORT.relative_to(ROOT)).replace("\\", "/"),
        "verdict": evidence["verdict"],
        "pairs": [
            {
                "label": row["label"],
                "changedPercent": row.get("changedPercent"),
                "changedPixels": row.get("changedPixels"),
                "changedBBox": row.get("changedBBox"),
                "identical": row.get("identical"),
                "before": row.get("before"),
                "after": row.get("after"),
            }
            for row in rows
        ],
        "failures": failures,
    }, indent=2))


if __name__ == "__main__":
    main()
