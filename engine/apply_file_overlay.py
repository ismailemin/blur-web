"""Apply the T-005c web scheduler overlay, then the T-005b file-layer overlay.

    python engine/apply_file_overlay.py --tree _work/engine-file-spike/tree

Order matters: the file layer is written against the platform identity the
scheduler overlay establishes (`PLATFORM_WEB` / `TL_PLAT_WEB` and the logging
closure it makes compilable for wasm32). The file patch is applied second and
cannot disturb the scheduler hunks.

Safety, identical to engine/apply_overlay.py:
  * refuses to run unless upstream/BlurRebuilt is a clean git checkout;
  * refuses any tree that is inside upstream/ (or is upstream/);
  * refuses to apply a hunk whose context does not match exactly (it reuses the
    shared applier, so it never fuzzes).

One difference, and the reason this tool exists instead of two calls to
apply_overlay.py: `System/Misc/Security.h` has **no newline at end of file**, and
apply_overlay.py rejects such files outright. The file patch changes one line in
the middle of that header (`= NULL` -> `= 0`, a pure-specifier), so this tool
applies the same strict hunk and then writes the file back with its original
line ending *and* its missing final newline, byte-for-byte.

It writes <tree>/.overlay/manifest.json (per engine/apply_overlay.py) and then
<tree>/.overlay/file-overlay.json, which records both patch hashes, both file
lists and the upstream commit.

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
sys.path.insert(0, str(Path(__file__).resolve().parent))
import apply_overlay as ao  # noqa: E402  (same directory, stdlib only)

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


def apply_file_patch(tree: Path, upstream: Path, patch: Path) -> tuple[list[str], list[str]]:
    """Apply added and modified files, preserving each file's exact bytes."""
    files = ao.parse_patch(patch.read_text(encoding="utf-8"))
    added: list[str] = []
    modified: list[str] = []

    for f in files:
        rel = f["rel"]
        dst = tree / rel
        dst.parent.mkdir(parents=True, exist_ok=True)

        if f["is_new"]:
            lines = ao.apply_hunks(rel, [], f["hunks"])
            dst.write_bytes(("\n".join(lines) + "\n").encode("utf-8"))
            added.append(rel)
            continue

        src = upstream / rel
        if not src.is_file():
            raise OverlayError(f"upstream is missing a file the patch modifies: {rel}")
        raw = src.read_bytes()
        eol = "\r\n" if b"\r\n" in raw else "\n"
        text = raw.decode("utf-8").replace("\r\n", "\n").replace("\r", "\n")
        trailing_newline = text.endswith("\n")
        body = text[:-1] if trailing_newline else text
        lines = ao.apply_hunks(rel, body.split("\n") if body else [], f["hunks"])
        out = eol.join(lines) + (eol if trailing_newline else "")
        dst.write_bytes(out.encode("utf-8"))
        modified.append(rel)

    if len(added) + len(modified) != len(files):
        raise OverlayError("internal error: not every patched file was written")
    return added, modified


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
    added, modified = apply_file_patch(tree, upstream, file_patch)

    commit = subprocess.run(["git", "rev-parse", "HEAD"], cwd=str(upstream),
                            capture_output=True, text=True).stdout.strip()

    record = {
        "purpose": "T-005b file layer + engine PAK consumer over the T-005c web "
                   "scheduler overlay (see docs/work/analysis/engine-file-layer.md)",
        "upstream": str(upstream),
        "upstream_commit": commit,
        "patches": [
            {"path": scheduler.name, "sha256": sha256(scheduler),
             "applied_first": True},
            {"path": file_patch.name, "sha256": sha256(file_patch),
             "applied_first": False},
        ],
        "files": {
            "added": sorted(added),
            "modified": sorted(modified),
        },
    }
    record_path = tree / ".overlay" / "file-overlay.json"
    record_path.parent.mkdir(parents=True, exist_ok=True)
    record_path.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")

    print(f"upstream commit {commit}")
    print(f"scheduler patch {scheduler.name} sha256={record['patches'][0]['sha256'][:16]}")
    print(f"file patch      {file_patch.name} sha256={record['patches'][1]['sha256'][:16]}")
    print(f"files           {len(added)} added, {len(modified)} modified")
    print(f"record          {record_path}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except OverlayError as exc:
        print(f"apply_file_overlay: ERROR: {exc}", file=sys.stderr)
        raise SystemExit(2)
