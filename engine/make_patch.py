"""Regenerate engine/patches/t005c-web-scheduler.patch from the spike overlay.

The overlay in _work/engine-web-spike/patched/ is what the wasm spike actually
compiled (see _work/engine-web-spike/make_patched_copy.py and its manifest
CHANGES.txt). This script turns exactly those edits into a reviewable unified
diff against upstream/BlurRebuilt/ paths, and refuses to emit anything that is
not in the expected file list.

    python engine/make_patch.py            # regenerate the patch
    python engine/make_patch.py --check    # verify the committed patch is current

Stdlib only. Reads upstream, never writes it.
"""
from __future__ import annotations

import difflib
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
UP = ROOT / "upstream/BlurRebuilt"
COMMON = "code/mercury/library/common"
PATCHED = ROOT / "_work/engine-web-spike/patched"
PATCH = ROOT / "engine/patches/t005c-web-scheduler.patch"

# (overlay path, path relative to upstream/BlurRebuilt, is_new)
FILES = [
    # --- core headers: maths/build grammar + atomics + debug trap -------------
    (PATCHED / "core/include/core/Core.h",
     f"{COMMON}/core/include/core/Core.h", False),
    (PATCHED / "core/include/core/maths/hvec/Vector.h",
     f"{COMMON}/core/include/core/maths/hvec/Vector.h", False),
    (PATCHED / "core/include/core/maths/hvec/Vector.inl",
     f"{COMMON}/core/include/core/maths/hvec/Vector.inl", False),
    (PATCHED / "core/include/core/maths/MathsUtil.h",
     f"{COMMON}/core/include/core/maths/MathsUtil.h", False),
    (PATCHED / "core/include/core/containers/sortedbinarytree.h",
     f"{COMMON}/core/include/core/containers/sortedbinarytree.h", False),
    (PATCHED / "core/include/btl/containers/map.h",
     f"{COMMON}/core/include/btl/containers/map.h", False),
    (PATCHED / "core/include/btl/containers/sortedbinarytree.inl",
     f"{COMMON}/core/include/btl/containers/sortedbinarytree.inl", False),
    (PATCHED / "core/include/core/threads/Event.h",
     f"{COMMON}/core/include/core/threads/Event.h", False),
    (PATCHED / "core/include/core/threads/Atomic.h",
     f"{COMMON}/core/include/core/threads/Atomic.h", False),
    # --- scheduler identity ---------------------------------------------------
    (PATCHED / "system/include/system/scheduler/core/mercury_to_tl.h",
     f"{COMMON}/system/include/system/scheduler/core/mercury_to_tl.h", False),
    (PATCHED / "system/include/system/scheduler/core/tl_defs.h",
     f"{COMMON}/system/include/system/scheduler/core/tl_defs.h", False),
    (PATCHED / "system/include/system/scheduler/core/tl_thread.h",
     f"{COMMON}/system/include/system/scheduler/core/tl_thread.h", False),
    (PATCHED / "system/include/system/scheduler/jobqueue.h",
     f"{COMMON}/system/include/system/scheduler/jobqueue.h", False),
    (PATCHED / "system/include/system/scheduler/core/tl_thread_web.h",
     f"{COMMON}/system/include/system/scheduler/core/tl_thread_web.h", True),
    (PATCHED / "system/include/system/scheduler/jobqueue_web.h",
     f"{COMMON}/system/include/system/scheduler/jobqueue_web.h", True),
    # --- translation units ----------------------------------------------------
    (PATCHED / "src/Event.cpp",
     f"{COMMON}/core/source/threads/Event.cpp", False),
    (PATCHED / "src/Mutex.cpp",
     f"{COMMON}/core/source/threads/Mutex.cpp", False),
    (PATCHED / "src/LogManager.cpp",
     f"{COMMON}/system/source/debug/log/LogManager.cpp", False),
    (PATCHED / "system/source/scheduler/jobqueue.cpp",
     f"{COMMON}/system/source/scheduler/jobqueue.cpp", False),
    (PATCHED / "system/source/scheduler/jobqueue_web.cpp",
     f"{COMMON}/system/source/scheduler/jobqueue_web.cpp", True),
]


def read_lines(path: Path) -> list[str]:
    """Read text as LF lines. Refuses files without a trailing newline so that the
    generated diff stays consumable by git apply as well as by apply_overlay.py."""
    with path.open("r", encoding="utf-8", newline="") as fh:
        text = fh.read()
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    if not text.endswith("\n"):
        raise SystemExit(f"{path}: no trailing newline (unsupported by this generator)")
    return text[:-1].split("\n")


def build_patch() -> str:
    chunks: list[str] = []
    for overlay, rel, is_new in FILES:
        if not overlay.exists():
            raise SystemExit(f"missing overlay file: {overlay}")
        old = [] if is_new else read_lines(UP / rel)
        new = read_lines(overlay)
        if old == new:
            raise SystemExit(f"no change in {rel}; the overlay is stale")
        from_name = "/dev/null" if is_new else f"a/{rel}"
        diff = difflib.unified_diff(old, new, fromfile=from_name, tofile=f"b/{rel}",
                                    lineterm="", n=3)
        chunks.append("\n".join(diff) + "\n")
    return "".join(chunks)


def main() -> int:
    text = build_patch()
    if "--check" in sys.argv:
        current = ""
        if PATCH.exists():
            with PATCH.open("r", encoding="utf-8", newline="") as fh:
                current = fh.read()
        if current == text:
            print(f"patch is current: {PATCH.relative_to(ROOT)}")
            return 0
        print("patch is STALE; run python engine/make_patch.py")
        return 1
    PATCH.parent.mkdir(parents=True, exist_ok=True)
    with PATCH.open("w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)
    added = sum(1 for l in text.split("\n") if l.startswith("+") and not l.startswith("+++"))
    removed = sum(1 for l in text.split("\n") if l.startswith("-") and not l.startswith("---"))
    print(f"wrote {PATCH.relative_to(ROOT)}: {len(FILES)} files, "
          f"+{added} -{removed} lines, {len(text)} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
