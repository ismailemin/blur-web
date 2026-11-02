"""Materialise the T-005c web-scheduler overlay into a caller-supplied tree.

    python engine/apply_overlay.py --tree _work/engine-overlay-check

What it does, in order:
  1. refuses to run unless upstream/BlurRebuilt is a clean git checkout;
  2. refuses to write anywhere inside upstream/;
  3. copies ONLY the upstream files the patch touches into <tree> at their
     upstream-relative paths (new files are created empty);
  4. applies engine/patches/t005c-web-scheduler.patch to those copies, verifying
     every context line (a mismatch is a hard failure, never a fuzzy apply);
  5. writes <tree>/.overlay/manifest.json and prints the tree path, the upstream
     commit, the patch hash and the manifest hash.

Line endings: the patch is LF. Existing upstream files keep their original
ending (CRLF); new files are written LF. Stdlib only; reads upstream, never
writes it.

Compile against the result by putting <tree>/code/mercury/library/common/... on
the include path *before* upstream's, exactly as the spike does.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_UPSTREAM = ROOT / "upstream/BlurRebuilt"
PATCH = ROOT / "engine/patches/t005c-web-scheduler.patch"

HUNK_RE = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")


class OverlayError(RuntimeError):
    pass


def sh(cmd: list[str], cwd: Path) -> subprocess.CompletedProcess:
    return subprocess.run([str(c) for c in cmd], cwd=str(cwd), capture_output=True,
                          text=True, errors="replace")


def upstream_commit(upstream: Path) -> str:
    p = sh(["git", "rev-parse", "HEAD"], upstream)
    if p.returncode != 0:
        raise OverlayError(f"cannot read the upstream commit: {p.stderr.strip()}")
    return p.stdout.strip()


def require_clean_upstream(upstream: Path) -> None:
    p = sh(["git", "status", "--porcelain"], upstream)
    if p.returncode != 0:
        raise OverlayError(
            "refusing to run: upstream is not a readable git checkout "
            f"({p.stderr.strip() or p.stdout.strip()}). The overlay must be built "
            "against a known-clean reference.")
    dirty = [l for l in p.stdout.splitlines() if l.strip()]
    if dirty:
        raise OverlayError(
            "refusing to run: upstream/BlurRebuilt is dirty. The overlay must be "
            "authored against a clean reference; restore it first.\n  "
            + "\n  ".join(dirty[:10])
            + (f"\n  ... and {len(dirty) - 10} more" if len(dirty) > 10 else ""))


def parse_patch(text: str) -> list[dict]:
    files: list[dict] = []
    old_path = None
    current = None
    for raw in text.split("\n"):
        if raw.startswith("--- "):
            old_path = raw[4:].split("\t")[0].strip()
        elif raw.startswith("+++ "):
            new_path = raw[4:].split("\t")[0].strip()
            rel = new_path[2:] if new_path.startswith("b/") else new_path
            current = {"rel": rel, "is_new": old_path == "/dev/null", "hunks": []}
            files.append(current)
        elif raw.startswith("@@ "):
            m = HUNK_RE.match(raw)
            if not m or current is None:
                raise OverlayError(f"unparsable hunk header: {raw!r}")
            current["hunks"].append({
                "old_start": int(m.group(1)),
                "old_len": int(m.group(2) or "1"),
                "new_start": int(m.group(3)),
                "new_len": int(m.group(4) or "1"),
                "lines": [],
            })
        elif current is not None and current["hunks"]:
            hunk = current["hunks"][-1]
            if raw.startswith("\\"):
                continue                      # "\ No newline at end of file"
            if raw.startswith("+"):
                hunk["lines"].append(("+", raw[1:]))
            elif raw.startswith("-"):
                hunk["lines"].append(("-", raw[1:]))
            elif raw.startswith(" "):
                hunk["lines"].append((" ", raw[1:]))
            elif raw == "":
                continue                      # separator between file sections
            else:
                raise OverlayError(f"unexpected patch line: {raw!r}")
    if not files:
        raise OverlayError("the patch contains no files")
    return files


def find_block(src: list[str], block: list[str], expected: int, floor: int) -> int:
    """Return the index of `block` in `src`, preferring `expected`.

    Only exact matches count; a patch that no longer fits is an error, never a
    fuzzy application."""
    if not block:
        return max(expected, floor)
    limit = len(src) - len(block)
    if limit < 0:
        raise OverlayError("hunk is longer than the file")
    for delta in range(0, len(src) + 1):
        for candidate in (expected - delta, expected + delta):
            if candidate < floor or candidate > limit:
                continue
            if src[candidate:candidate + len(block)] == block:
                return candidate
    return -1


def apply_hunks(rel: str, src: list[str], hunks: list[dict]) -> list[str]:
    out: list[str] = []
    cursor = 0
    for h in hunks:
        old_block = [c for t, c in h["lines"] if t in " -"]
        new_block = [c for t, c in h["lines"] if t in " +"]
        if len(old_block) != h["old_len"] or len(new_block) != h["new_len"]:
            raise OverlayError(
                f"{rel}: hunk @@ -{h['old_start']},{h['old_len']} @@ declares "
                f"{h['old_len']}/{h['new_len']} lines but carries "
                f"{len(old_block)}/{len(new_block)}")
        idx = find_block(src, old_block, max(0, h["old_start"] - 1), cursor)
        if idx < 0:
            raise OverlayError(
                f"{rel}: hunk @@ -{h['old_start']},{h['old_len']} @@ does not apply "
                f"(context mismatch at or after line {cursor + 1})")
        out.extend(src[cursor:idx])
        for tag, content in h["lines"]:
            if tag in " +":
                out.append(content)
        cursor = idx + len(old_block)
    out.extend(src[cursor:])
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tree", required=True, help="build tree to populate")
    ap.add_argument("--upstream", default=str(DEFAULT_UPSTREAM))
    ap.add_argument("--patch", default=str(PATCH))
    ap.add_argument("--force", action="store_true",
                    help="overwrite files that already exist in the tree")
    args = ap.parse_args()

    upstream = Path(args.upstream).resolve()
    tree = Path(args.tree).resolve()
    patch_path = Path(args.patch).resolve()
    if not upstream.is_dir():
        raise OverlayError(f"upstream not found: {upstream}")
    if not patch_path.is_file():
        raise OverlayError(f"patch not found: {patch_path}")
    if tree == upstream or upstream in tree.parents:
        raise OverlayError(
            f"refusing to write into upstream ({tree}); choose a tree outside it")

    require_clean_upstream(upstream)
    commit = upstream_commit(upstream)

    patch_bytes = patch_path.read_bytes()
    patch_sha = hashlib.sha256(patch_bytes).hexdigest()
    files = parse_patch(patch_bytes.decode("utf-8"))

    plan: list[tuple[dict, Path, Path]] = []
    for f in files:
        src = upstream / f["rel"]
        dst = tree / f["rel"]
        if not f["is_new"] and not src.is_file():
            raise OverlayError(f"upstream is missing a file the patch modifies: {f['rel']}")
        if dst.exists() and not args.force:
            raise OverlayError(
                f"{dst} already exists; pass --force to overwrite (the overlay is "
                "regenerated from upstream on every run)")
        plan.append((f, src, dst))

    written = []
    for f, src, dst in plan:
        dst.parent.mkdir(parents=True, exist_ok=True)
        if f["is_new"]:
            text, eol = "", "\n"
        else:
            raw = src.read_bytes()
            eol = "\r\n" if b"\r\n" in raw else "\n"
            text = raw.decode("utf-8").replace("\r\n", "\n").replace("\r", "\n")
            if text and not text.endswith("\n"):
                raise OverlayError(f"{f['rel']}: no trailing newline (unsupported)")
        lines = text[:-1].split("\n") if text else []
        patched = apply_hunks(f["rel"], lines, f["hunks"])
        body = eol.join(patched) + (eol if patched else "")
        dst.write_bytes(body.encode("utf-8"))
        written.append(f["rel"])

    if len(written) != len(files):
        raise OverlayError("internal error: not every patched file was written")

    manifest_hash = hashlib.sha256()
    for rel in sorted(written):
        manifest_hash.update(rel.encode("utf-8") + b"\0")
        manifest_hash.update((tree / rel).read_bytes())
    manifest_hash_hex = manifest_hash.hexdigest()

    manifest = {
        "purpose": "T-005c web scheduler overlay (see docs/work/analysis/engine-web-shims.md)",
        "upstream": str(upstream),
        "upstream_commit": commit,
        "patch": patch_path.name,
        "patch_sha256": patch_sha,
        "files": [{"path": rel, "new": any(f["rel"] == rel and f["is_new"] for f in files)}
                  for rel in sorted(written)],
        "manifest_sha256": manifest_hash_hex,
    }
    meta = tree / ".overlay" / "manifest.json"
    meta.parent.mkdir(parents=True, exist_ok=True)
    meta.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    print(f"tree            {tree}")
    print(f"upstream commit {commit}")
    print(f"patch           {patch_path.name} sha256={patch_sha[:16]}")
    print(f"files           {len(written)}")
    print(f"manifest        sha256={manifest_hash_hex[:16]}  ({meta})")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except OverlayError as exc:
        print(f"apply_overlay: ERROR: {exc}", file=sys.stderr)
        raise SystemExit(2)
