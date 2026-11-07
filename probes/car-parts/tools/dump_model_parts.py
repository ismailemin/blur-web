"""Dump the committed MdlDat part layer of one decoded `.model` as JSON.

Read-only diagnostic used to compare element names, parents and local bounds
against the part builder's expected wheel-group members. It reuses the exact
parser in `build_manifest.py`; it does not add any format knowledge.

Usage:
  python probes/car-parts/tools/dump_model_parts.py --model <decoded.model>
      [--model-index 0] [--out <json>]

Without `--model-index` every model record is listed and every element is
emitted. With `--model-index` only that model's elements are emitted.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import build_manifest as bm  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True, type=Path)
    parser.add_argument("--model-index", type=int, default=None)
    parser.add_argument("--out", type=Path, default=None)
    args = parser.parse_args()

    mdl = bm.parse_mdldat(args.model.read_bytes())
    models = mdl["models"]
    elements = mdl["elements"]
    if args.model_index is not None:
        if not 0 <= args.model_index < len(models):
            raise SystemExit(f"model index {args.model_index} out of range (0..{len(models) - 1})")
        elements = [element for element in elements if element["modelIndex"] == args.model_index]

    def element_row(element: dict) -> dict:
        return {
            "index": element["index"],
            "modelIndex": element["modelIndex"],
            "name": element["name"],
            "parent": element["parent"],
            "firstChild": element["firstChild"],
            "nextSibling": element["nextSibling"],
            "renderMeshId": element["renderMeshId"],
            "physicsShapeId": element["physicsShapeId"],
            "min": element["min"],
            "max": element["max"],
            "linearIdentity": element["linearIdentity"],
        }

    doc = {
        "input": str(args.model),
        "models": [{key: model[key] for key in
                    ("index", "name", "parent", "firstChild", "nextSibling",
                     "elementCount", "firstElement", "linearIdentity")}
                   for model in models],
        "elements": [element_row(element) for element in elements],
    }
    text = json.dumps(doc, indent=2, sort_keys=True) + "\n"
    if args.out is not None:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(text, encoding="utf-8")
        print(f"wrote {args.out} ({len(elements)} elements)")
    else:
        print(text, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
