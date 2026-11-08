#!/usr/bin/env python3
"""Write probes/map-pipeline/data/map-decisions.json.

The document is a pure function of the committed probe/batch documents and the
E1 map registry. Run `verify_map_decisions.py` afterwards; it rebuilds the
document and compares it byte-for-byte.
"""
from __future__ import annotations

import argparse
from pathlib import Path

import map_decisions_lib as lib


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, default=lib.DECISIONS_PATH)
    args = parser.parse_args(argv)
    doc = lib.build_document()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(lib.serialise(doc))
    print("wrote %s" % args.out)
    print("levels=%d playable=%d blocked=%d unsupported=%d" % (
        doc["summary"]["levelCount"],
        doc["summary"]["counts"]["playable"],
        doc["summary"]["counts"]["blocked"],
        doc["summary"]["counts"]["unsupported"]))
    print("canonicalSha256=%s" % doc["canonicalSha256"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
