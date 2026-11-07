#!/usr/bin/env python3
"""Compile every mercury/library/ai/air TU with the existing web headers.

This is an audit probe, not a build of the game. It uses the patched common
tree already produced by _work/engine-vehicle-spike/build.py (the same tree the
vehicle wasm spike compiled against) and the t005b/t005c platform headers.
Source files are read from upstream/, never modified.

Output: _work/game-logic-audit/ai-compile-probe.json
Logs:   _work/logs/game-logic-audit/ai-compile/
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
UP = ROOT / "upstream" / "BlurRebuilt" / "code" / "mercury" / "library"
AIR_SRC = UP / "ai" / "air" / "source"
AIR_INC = UP / "ai" / "air" / "include"
TREE = ROOT / "_work" / "engine-vehicle-spike" / "tree" / "code" / "mercury" / "library"
EM = ROOT / "_work" / "toolchains" / "emsdk" / "upstream" / "emscripten" / "em++.py"
OUT = ROOT / "_work" / "game-logic-audit" / "ai-compile-probe.json"
LOGDIR = ROOT / "_work" / "logs" / "game-logic-audit" / "ai-compile"
OBJDIR = ROOT / "_work" / "game-logic-audit" / "obj"

FLAGS = [
    "-DBUILD_CONFIG_SPEED",
    "-DPLATFORM_WEB",
    "-std=c++14",
    "-O0",
    "-fno-fast-math",
    "-ffp-contract=off",
    "-fdelayed-template-parsing",
    "-D__restrict=",
    "-fdeclspec",
    "-Wno-nonportable-include-path",
    "-Wno-ignored-attributes",
    "-Wno-deprecated-register",
    "-Wno-return-type",
    "-Wno-c++20-extensions",
    "-Wno-c++11-narrowing",
    "-include",
    str(ROOT / "engine" / "harness" / "t005b" / "msvc_crt_web.h"),
    "-include",
    str(ROOT / "engine" / "harness" / "t005c" / "web_platform.h"),
]

INCLUDES = [
    "-I" + str(AIR_INC),
    "-I" + str(TREE / "common" / "core" / "include"),
    "-I" + str(TREE / "common" / "core"),
    "-I" + str(TREE / "common" / "system" / "include"),
    "-I" + str(TREE / "common" / "btl" / "include"),
    "-I" + str(TREE / "common" / "system"),
    "-I" + str(UP / "ai" / "air"),
]

ERR_RE = re.compile(r"error:")


def main() -> int:
    if not EM.exists():
        print(f"missing em++: {EM}", file=sys.stderr)
        return 2
    if not TREE.exists():
        print(f"missing patched tree: {TREE}", file=sys.stderr)
        return 2
    LOGDIR.mkdir(parents=True, exist_ok=True)
    OBJDIR.mkdir(parents=True, exist_ok=True)

    tus = sorted(p.relative_to(AIR_SRC).as_posix() for p in AIR_SRC.rglob("*.cpp"))
    results = []
    for index, tu in enumerate(tus):
        src = AIR_SRC / tu
        obj = OBJDIR / f"air_{index:03d}_{Path(tu).stem}.o"
        log = LOGDIR / f"{index:03d}_{Path(tu).stem}.log"
        cmd = [
            sys.executable,
            str(EM),
            *FLAGS,
            *INCLUDES,
            "-c",
            str(src),
            "-o",
            str(obj),
        ]
        p = subprocess.run(cmd, capture_output=True, text=True, errors="replace")
        text = (p.stdout or "") + (p.stderr or "")
        log.write_text("$ " + " ".join(cmd) + "\n" + text, encoding="utf-8")
        errors = len(ERR_RE.findall(text))
        first = ""
        for line in text.splitlines():
            if "error:" in line:
                first = line.strip()[:240]
                break
        results.append(
            {
                "tu": tu,
                "compiled": p.returncode == 0,
                "errors": errors,
                "firstError": first,
                "object": obj.relative_to(ROOT).as_posix() if p.returncode == 0 else "",
                "log": log.relative_to(ROOT).as_posix(),
            }
        )
        print(f"{'PASS' if p.returncode == 0 else 'FAIL'} {tu} errors={errors}")

    payload = {
        "schema": "blur-web.ai-compile-probe.v1",
        "sourceCommit": subprocess.check_output(
            ["git", "-C", str(ROOT / "upstream" / "BlurRebuilt"), "rev-parse", "HEAD"],
            text=True,
        ).strip(),
        "toolchain": "emscripten em++.py from _work/toolchains/emsdk",
        "includeBase": TREE.relative_to(ROOT).as_posix(),
        "flags": FLAGS,
        "counts": {
            "tus": len(results),
            "compiled": sum(1 for r in results if r["compiled"]),
            "failed": sum(1 for r in results if not r["compiled"]),
        },
        "limits": [
            "Compiled objects only; no link, run or numerical parity.",
            "The include tree is the already patched _work/engine-vehicle-spike tree.",
            "This does not put AI into the existing wasm closure.",
        ],
        "tus": results,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    print(f"wrote {OUT}")
    print(payload["counts"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
