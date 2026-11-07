#!/usr/bin/env python3
"""Read-only draw inventory for all level directories.

Two independent measurements per level:

1. `level_inspect --index Level.levelrender` (native reader): resource block
   count, stream chunk count and first-LOD0 item count. This is a header/stream
   index only; no geometry is imported.
2. `tools/inspect_level_candidates.inspect_level` (committed Python reader):
   first RenderList direct geometry/node correlated pairs, node chunks parsed,
   geometry blocks seen, and parse errors. This preserves
   `instancesApplied:false`: only first RenderList direct primitives count.

No file under game-data, tools/ or another probe is modified.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tools"))
import inspect_level_candidates as candidates  # noqa: E402

LEVEL_INSPECT = ROOT / "_work/build/asset-reader-native/Release/level_inspect.exe"
OUT = ROOT / "_work/map-pipeline/draws.json"


def native_index(level: str):
    render = ROOT / "game-data/Blur/levels" / level / "Level.levelrender"
    if not render.is_file():
        return {"status": "missing"}
    proc = subprocess.run([str(LEVEL_INSPECT), "--index", str(render)],
                          capture_output=True, text=True, encoding="utf-8",
                          timeout=120, check=False)
    if proc.returncode != 0:
        return {"status": "error", "error": proc.stderr[:300] or proc.stdout[:300]}
    try:
        doc = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        return {"status": "error", "error": "json: %s" % exc}
    chunks = doc.get("streamChunks", [])
    lod0 = 0
    prereq = 0
    for chunk in chunks:
        lod0 += sum(1 for item in chunk.get("items", []) if item.get("lod") == 0)
        if chunk.get("prerequisites"):
            prereq += 1
    return {
        "status": "ok",
        "scope": doc.get("metadata", {}).get("scope"),
        "resourceBlockCount": doc.get("resourceBlockCount"),
        "initiallyLoadedBlocks": doc.get("initiallyLoadedBlocks"),
        "streamChunkCount": len(chunks),
        "firstLod0ItemCount": lod0,
        "chunksWithPrerequisites": prereq,
    }


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=OUT)
    args = ap.parse_args(argv)
    levels = sorted(p.name for p in (ROOT / "game-data/Blur/levels").iterdir()
                    if p.is_dir())
    statistics = Counter()
    errors = []
    rows = []
    for name in levels:
        row = {"level": name}
        row["nativeIndex"] = native_index(name)
        # inspect_level returns pairs and a summary; it does not write files.
        pairs, summary = candidates.inspect_level(name, statistics, errors)
        row["reader"] = summary
        row["correlatedPairCount"] = len(pairs)
        row["correlatedPairTriangleEstimate"] = sum(
            p["estimatedSourceIndexCount"] // 3 for p in pairs)
        row["pairSamples"] = [
            {"geometryBlock": p["geometryBlock"],
             "geometryChunkIndex": p["geometryChunkIndex"],
             "nodeBlock": p["node"]["record"]["items"][0]["block"],
             "nodeChunkIndex": p["node"]["chunkIndex"],
             "estimatedSourceIndexCount": p["estimatedSourceIndexCount"]}
            for p in sorted(pairs, key=lambda p: p["estimatedSourceIndexCount"],
                            reverse=True)[:10]
        ]
        row["levelErrors"] = [e for e in errors if e.get("level") == name][:10]
        rows.append(row)
    doc = {
        "schema": "blur.map-pipeline.draws/1",
        "scope": ("read-only draw inventory: native levelrender index plus committed "
                  "first-RenderList direct geometry/node correlation; instancesApplied:false"),
        "statistics": dict(statistics),
        "levelCount": len(rows),
        "levels": rows,
        "parseErrorCount": len(errors),
        "parseErrors": errors[:80],
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(doc, indent=1, sort_keys=True) + "\n",
                        encoding="utf-8")
    print(json.dumps({"levels": len(rows), "statistics": dict(statistics),
                      "parseErrors": len(errors)}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
