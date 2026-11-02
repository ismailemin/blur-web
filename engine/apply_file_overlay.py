"""Apply the T-005c web scheduler overlay, then the T-005b file-layer overlay.

    python engine/apply_file_overlay.py --tree _work/engine-file-spike/tree

Order matters: the file layer is written against the platform identity the
scheduler overlay establishes (`PLATFORM_WEB` / `TL_PLAT_WEB` and the logging
closure it makes compilable for wasm32). The file patch itself adds three new
files and modifies none, so it is applied second and cannot disturb the
scheduler hunks.

Safety, identical to engine/apply_overlay.py:
  * refuses to run unless upstream/BlurRebuilt is a clean git checkout;
  * refuses any tree that is inside upstream/ (or is upstream/);
  * refuses to apply a patch whose context does not match exactly (the shared
    applier verifies every context line, it never fuzzes).

It writes <tree>/.overlay/manifest.json (per engine/apply_overlay.py) and then
<tree>/.overlay/file-overlay.json, which records both patch hashes, both file
lists and the upstream commit, so a later check knows exactly what was applied
without rerunning the applier.

Stdlib only; reads upstream, writes only inside the tree.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_UPSTREAM = ROOT / "upstream/BlurRebuilt"
SCHEDULER_PATCH = ROOT / "engine/patches/t005c-web-scheduler.patch"
FILE_PATCH = ROOT / "engine/patches/t005b-file-overlay.patch"
APPLY = ROOT / "engine/apply_overlay.py"


class OverlayError(RuntimeError):
    pass


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run_apply(tree: Path, upstream: Path, patch: Path) -> str:
    p = subprocess.run(
        [sys.executable, str(APPLY), "--tree", str(tree), "--upstream", str(upstream),
         "--patch", str(patch), "--force"],
        capture_output=True, text=True, errors="replace")
    if p.returncode != 0:
        raise OverlayError(
            f"applying {patch.name} failed ({p.returncode}):\n"
            f"{(p.stderr or p.stdout).strip()}")
    return (p.stdout or "").strip()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tree", required=True, help="build tree to populate")
    ap.add_argument("--upstream", default=str(DEFAULT_UPSTREAM))
    ap.add_argument("--scheduler-patch", default=str(SCHEDULER_PATCH))
    ap.add_argument("--file-patch", default=str(FILE_PATCH))
    args = ap.parse_args()

    upstream = Path(args.upstream).resolve()
    tree = Path(args.tree).resolve()
    scheduler = Path(args.scheduler_patch).resolve()
    file_patch = Path(args.file_patch).resolve()

    if not upstream.is_dir():
        raise OverlayError(f"upstream not found: {upstream}")
    for patch in (scheduler, file_patch):
        if not patch.is_file():
            raise OverlayError(f"patch not found: {patch}")
    if tree == upstream or upstream in tree.parents:
        raise OverlayError(
            f"refusing to write into upstream ({tree}); choose a tree outside it")

    # engine/apply_overlay.py enforces the clean-upstream rule; this is the
    # same check made early so the message names this tool.
    status = subprocess.run(["git", "status", "--porcelain"], cwd=str(upstream),
                            capture_output=True, text=True, errors="replace")
    if status.returncode != 0:
        raise OverlayError(
            "refusing to run: upstream is not a readable git checkout "
            f"({(status.stderr or status.stdout).strip()})")
    dirty = [line for line in status.stdout.splitlines() if line.strip()]
    if dirty:
        raise OverlayError(
            "refusing to run: upstream/BlurRebuilt is dirty; restore it first.\n  "
            + "\n  ".join(dirty[:10]))

    print(run_apply(tree, upstream, scheduler))
    print(run_apply(tree, upstream, file_patch))

    commit = subprocess.run(["git", "rev-parse", "HEAD"], cwd=str(upstream),
                            capture_output=True, text=True).stdout.strip()

    record = {
        "purpose": "T-005b file layer over the T-005c web scheduler overlay "
                   "(see docs/work/analysis/engine-file-layer.md)",
        "upstream": str(upstream),
        "upstream_commit": commit,
        "patches": [
            {"path": scheduler.name, "sha256": sha256(scheduler),
             "applied_first": True},
            {"path": file_patch.name, "sha256": sha256(file_patch),
             "applied_first": False},
        ],
        "file_patch_adds_only": True,
    }
    record_path = tree / ".overlay" / "file-overlay.json"
    record_path.parent.mkdir(parents=True, exist_ok=True)
    record_path.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")

    print(f"upstream commit {commit}")
    print(f"scheduler patch {scheduler.name} sha256={record['patches'][0]['sha256'][:16]}")
    print(f"file patch      {file_patch.name} sha256={record['patches'][1]['sha256'][:16]}")
    print(f"record          {record_path}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except OverlayError as exc:
        print(f"apply_file_overlay: ERROR: {exc}", file=sys.stderr)
        raise SystemExit(2)
