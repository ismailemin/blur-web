#!/usr/bin/env python3
"""Map batch compiler — command line entry point.

    # one map
    python probes/map-batch/build_map.py --level usa_amboy

    # every level directory that has the required files
    python probes/map-batch/build_map.py --all

    # two independent builds per level, byte-identical manifest/draws/path
    python probes/map-batch/build_map.py --all --determinism

Outputs (generated game data, never committed):
    _work/map-batch/<level>/...
    _work/map-batch/batch-summary.json
    _work/map-batch/determinism.json
    _work/logs/map-batch/*.log

No renderer, GPU, browser, engine-physics or playable-game claim is made.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import map_batch_lib as batch  # noqa: E402


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class Tee:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.handle = path.open("w", encoding="utf-8")

    def __call__(self, message: str) -> None:
        print(message, flush=True)
        self.handle.write(message + "\n")
        self.handle.flush()

    def close(self) -> None:
        self.handle.close()


def compare_builds(primary: Path, regen: Path) -> dict:
    manifest_path = primary / "manifest.json"
    if not manifest_path.is_file():
        return {"identical": False, "error": "primary manifest missing",
                "mismatches": []}
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    files = sorted(manifest["hashes"]["files"])
    mismatches = []
    compared = 0
    for name in files:
        left = primary / name
        right = regen / name
        compared += 1
        if not right.is_file():
            mismatches.append({"file": name, "reason": "missing in second build"})
        elif left.read_bytes() != right.read_bytes():
            mismatches.append({"file": name,
                               "primarySha256": sha256_file(left),
                               "regenSha256": sha256_file(right)})
    for name in ("manifest.json", "draws.json", "path.json"):
        left, right = primary / name, regen / name
        if name not in files:
            compared += 1
            if not right.is_file() or left.read_bytes() != right.read_bytes():
                mismatches.append({"file": name, "reason": "differs or missing"})
    hashes = {
        "manifest": sha256_file(primary / "manifest.json"),
        "manifestContentSha256": manifest["hashes"]["contentSha256"],
        "draws": sha256_file(primary / "draws.json"),
        "path": sha256_file(primary / "path.json"),
    }
    regen_hashes = {
        "manifest": sha256_file(regen / "manifest.json") if (regen / "manifest.json").is_file() else None,
        "draws": sha256_file(regen / "draws.json") if (regen / "draws.json").is_file() else None,
        "path": sha256_file(regen / "path.json") if (regen / "path.json").is_file() else None,
    }
    return {"identical": not mismatches, "filesCompared": compared,
            "mismatches": mismatches, "hashes": hashes,
            "regenHashes": regen_hashes}


def run_level(level: str, *, textures: bool, determinism: bool,
              out: Path, keep_regen: bool, log) -> dict:
    log("=== %s ===" % level)
    result = batch.build_level(level, out, textures=textures, log=log)
    log("[%s] %s  draws=%d collision=%d path=%.3f m coverage=%.4f  %.1fs" % (
        level, result["grade"], result["counts"]["draws"],
        result["counts"]["collisionTriangles"], result["counts"]["drawCoveredPathM"],
        result["counts"]["coverageOfCollisionDiameter"], result["totalSeconds"]))
    if determinism:
        regen = batch.BATCH / ".regen" / level
        if regen.exists():
            shutil.rmtree(regen)
        log("[%s] determinism rebuild -> %s" % (level, batch.rel(regen)))
        batch.build_level(level, regen, textures=textures, log=log)
        comparison = compare_builds(out, regen)
        log("[%s] determinism identical=%s files=%d mismatches=%d" % (
            level, comparison["identical"], comparison.get("filesCompared", 0),
            len(comparison.get("mismatches", []))))
        result["determinism"] = comparison
        if not keep_regen:
            shutil.rmtree(regen, ignore_errors=True)
    return result


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--level", action="append", default=None,
                        help="level id (repeatable)")
    parser.add_argument("--all", action="store_true", help="every level directory")
    parser.add_argument("--out", default=None,
                        help="output directory for a single --level build")
    parser.add_argument("--no-textures", action="store_true",
                        help="skip the texture decode/join stage")
    parser.add_argument("--determinism", action="store_true",
                        help="build twice and compare every pinned file")
    parser.add_argument("--keep-regen", action="store_true",
                        help="keep the second (determinism) build")
    args = parser.parse_args(argv)

    if not args.all and not args.level:
        parser.error("use --all or at least one --level")

    levels = batch.all_levels() if args.all else args.level
    if args.out and (args.all or len(levels) != 1):
        parser.error("--out is only valid for a single --level build")

    started = time.perf_counter()
    batch.LOGS.mkdir(parents=True, exist_ok=True)
    log_name = "build-all.log" if args.all else "build-%s.log" % levels[0]
    log = Tee(batch.LOGS / log_name)

    rows = []
    try:
        for level in levels:
            out = (Path(args.out) if args.out else batch.BATCH / level).resolve()
            try:
                rows.append(run_level(level, textures=not args.no_textures,
                                      determinism=args.determinism, out=out,
                                      keep_regen=args.keep_regen, log=log))
            except Exception as error:  # noqa: BLE001 - keep the batch running
                log("[%s] FAILED: %s: %s" % (level, type(error).__name__, error))
                rows.append({"level": level, "grade": "error",
                             "error": "%s: %s" % (type(error).__name__, error)})
    finally:
        total = time.perf_counter() - started
        log("=== total %.1fs for %d level(s) ===" % (total, len(rows)))
        log.close()

    summary = {
        "schema": "blur.map-batch.batch/1",
        "generatedBy": "probes/map-batch/build_map.py",
        "options": {"levels": levels, "all": args.all,
                    "textures": not args.no_textures,
                    "determinism": args.determinism},
        "levelCount": len(rows),
        "totalSeconds": round(total, 4),
        "levels": rows,
    }
    batch.write_json(batch.BATCH / "batch-summary.json", summary)

    if args.determinism:
        determinism = {
            "schema": "blur.map-batch.determinism/1",
            "generatedBy": "probes/map-batch/build_map.py --determinism",
            "rule": "two independent builds; every manifest-pinned file plus "
                    "manifest.json/draws.json/path.json compared byte-for-byte",
            "levelCount": len(rows),
            "allIdentical": all(row.get("determinism", {}).get("identical", False)
                                for row in rows),
            "levels": [{
                "level": row["level"],
                "identical": row.get("determinism", {}).get("identical", False),
                "filesCompared": row.get("determinism", {}).get("filesCompared"),
                "mismatches": row.get("determinism", {}).get("mismatches", []),
                "hashes": row.get("determinism", {}).get("hashes"),
                "regenHashes": row.get("determinism", {}).get("regenHashes"),
            } for row in rows],
        }
        batch.write_json(batch.BATCH / "determinism.json", determinism)

    print(json.dumps({
        "levelCount": len(rows),
        "totalSeconds": round(total, 4),
        "grades": {row["level"]: row.get("grade") for row in rows},
        "determinism": (all(row.get("determinism", {}).get("identical", False)
                            for row in rows) if args.determinism else None),
        "summary": batch.rel(batch.BATCH / "batch-summary.json"),
    }, indent=1))
    return 0 if all(row.get("grade") != "error" for row in rows) else 1


if __name__ == "__main__":
    raise SystemExit(main())
