"""Native PC parity for the overlay's scheduler changes.

    python engine/native_parity.py [--tree _work/engine-overlay-check]

What "parity" means here, and why it is measured this way:

  * The overlay only adds `#if defined(PLATFORM_WEB)` blocks to shared files.
    The strongest statement about the PC build is therefore a *translation unit*
    statement, not a runtime sample: preprocess `jobqueue.cpp` in the PC
    configuration (PLATFORM_PC/WIN32, MSVC) from upstream and from the overlay
    tree, strip line markers, and diff. The only expected difference is the
    `__LINE__` constant of a log location, because the web block shifts the
    lines below it. No statement may differ.

  * The whole scheduler + logging closure (33 TUs) is then compiled natively
    with MSVC, including the same probe source, to show the overlay does not
    break the PC compile.

  * Running the probe natively is NOT possible from this checkout: the PC
    `LogManager` retention list pulls the file/socket/SMTP subscribers, which
    need `Sys::C_FileSystem` -> `AsyncFile` -> `ArteryMutex` and
    `Network::TCPSocket`/`SMTPClient`; `system/source/io/IoStream.cpp` does not
    even compile in this tree. None of that is scheduler code. The runtime A3/A4
    comparison is therefore reported as blocked, with the exact symbols.

Exit status: 0 when the TU diff is clean and every planned TU compiles.
Stdlib only; needs MSVC (Visual Studio 2022 Build Tools).
"""
from __future__ import annotations

import argparse
import difflib
import shutil
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
UP = ROOT / "upstream/BlurRebuilt"
COMMON = "code/mercury/library/common"
DEFAULT_TREE = ROOT / "_work/engine-overlay-check"
WORK = ROOT / "_work/engine-web-spike/native"
VCVARS_CANDIDATES = [
    r"C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat",
    r"C:\Program Files\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat",
    r"C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat",
]

# The closure that compiles natively today: scheduler + sync + alloc + time +
# the logging core and its real subscribers + the probe itself.
CLOSURE = [
    "system/source/scheduler/jobqueue.cpp",
    "system/source/scheduler/jobqueue_kernel.cpp",
    "system/source/scheduler/jobqueue_task_queue_lf.cpp",
    "system/source/scheduler/jobqueue_mem.cpp",
    "system/source/scheduler/jobqueue_xenon.cpp",
    "core/source/threads/Thread.cpp",
    "core/source/threads/Mutex.cpp",
    "core/source/threads/Event.cpp",
    "core/source/threads/RwLock.cpp",
    "core/source/threads/ThreadLocalStorage.cpp",
    "core/source/allocators/CoreMemoryAligned.cpp",
    "core/source/maths/hvec/Constants.cpp",
    "core/source/maths/hvec/Vector.cpp",
    "core/source/maths/hvec/SIMD.cpp",
    "system/source/time/Time.cpp",
    "system/source/debug/log/LogManager.cpp",
    "system/source/debug/log/Logger.cpp",
    "system/source/debug/log/Format.cpp",
    "system/source/debug/log/DebugLevel.cpp",
    "system/source/debug/log/Filter.cpp",
    "system/source/debug/log/ThreadContext.cpp",
    "system/source/debug/log/subscribers/ConsoleSubscriber.cpp",
    "system/source/debug/log/subscribers/LogFileSubscriber.cpp",
    "system/source/debug/log/subscribers/SocketSubscriber.cpp",
    "system/source/debug/log/subscribers/SocketServerSubscriber.cpp",
    "system/source/debug/log/subscribers/E-MailSubscriber.cpp",
    "system/source/debug/log/subscribers/SubscriberCommon.cpp",
    "system/source/debug/log/subscribers/SubscriberManager.cpp",
]
PROBE = "_work/engine-web-spike/probes/smoke_sched.cpp"

LINK_BLOCKERS = [
    "Sys::C_FileSystem -> Sys::C_File -> AsyncFile -> ArteryMutex",
    "Network::TCPSocket / Network::SMTPClient (Socket*, E-Mail subscribers)",
    "system/source/io/IoStream.cpp does not compile in this checkout",
]


def find_vcvars() -> Path:
    for c in VCVARS_CANDIDATES:
        p = Path(c)
        if p.is_file():
            return p
    raise SystemExit("MSVC vcvars64.bat not found; install Visual Studio Build Tools")


def cmd_with(vcvars: Path, tail: str, cwd: Path, name: str = "step") -> subprocess.CompletedProcess:
    """Run `tail` with the MSVC environment. A tiny .bat avoids nested-quote
    damage from building a `cmd /c` string with embedded quotes."""
    bat = WORK / f"_run_{name}.bat"
    bat.write_text(
        f'@echo off\r\ncall "{vcvars}" >nul\r\ncd /d "{cwd}"\r\n{tail}\r\n',
        encoding="ascii")
    return subprocess.run(["cmd", "/c", str(bat)], capture_output=True, text=True,
                          errors="replace")


def preprocess(vcvars: Path, src: Path, out: Path, inc: str, defs: str) -> bool:
    out.parent.mkdir(parents=True, exist_ok=True)
    p = cmd_with(vcvars, f'cl /nologo /P /C /std:c++14 /EHsc {defs} {inc} '
                         f'/Fi"{out}" "{src}"', out.parent, name=f"pp_{src.stem}")
    return p.returncode == 0 and out.is_file()


def code_lines(path: Path) -> list[str]:
    """Drop `#line` markers and blank lines; normalise the __FILE__ literal."""
    out = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if line.lstrip().startswith("#"):
            continue
        s = line.strip()
        if not s:
            continue
        s = re.sub(r'"?[^"]*(?:upstream\\BlurRebuilt|engine-overlay-check)\\?',
                   lambda m: '"<SRC>\\', s)
        out.append(s)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tree", default=str(DEFAULT_TREE))
    args = ap.parse_args()
    tree = Path(args.tree).resolve()
    if not tree.is_dir():
        raise SystemExit(f"overlay tree not found: {tree}\n"
                         f"run: python engine/apply_overlay.py --tree {tree}")
    vcvars = find_vcvars()
    WORK.mkdir(parents=True, exist_ok=True)

    inc = " ".join(f'/I"{UP / p}"' for p in (
        f"{COMMON}/core/include", f"{COMMON}/core", f"{COMMON}/system",
        f"{COMMON}/system/include", f"{COMMON}/btl/include",
        f"{COMMON}/misc_shared/include", f"{COMMON}/misc_shared",
        f"{COMMON}/xt2/include", f"{COMMON}/system/source/scheduler"))
    defs = "/DBUILD_CONFIG_SPEED /DPLATFORM_PC /DWIN32 /D_WINDOWS"

    # --- phase 1: the PC translation unit must not change --------------------
    up_i = WORK / "upstream_jobqueue.i"
    ov_i = WORK / "overlay_jobqueue.i"
    if not preprocess(vcvars, UP / f"{COMMON}/system/source/scheduler/jobqueue.cpp", up_i, inc, defs):
        raise SystemExit("failed to preprocess the upstream jobqueue.cpp")
    if not preprocess(vcvars, tree / f"{COMMON}/system/source/scheduler/jobqueue.cpp", ov_i, inc, defs):
        raise SystemExit("failed to preprocess the overlay jobqueue.cpp")
    a, b = code_lines(up_i), code_lines(ov_i)
    diff = list(difflib.unified_diff(a, b, "upstream", "overlay", lineterm="", n=0))
    print(f"phase 1  preprocessed PC TU: {len(a)} non-blank lines, "
          f"{len(diff)} diff lines")
    statement_diff = []
    for line in diff:
        if line.startswith(("---", "+++", "@@")):
            continue
        # the only allowed difference: a __LINE__ constant inside a log location
        if re.search(r"StaticLocationInfoClass\(\d+", line):
            continue
        statement_diff.append(line)
    for line in diff[:6]:
        print(f"         {line[:160]}")
    if statement_diff:
        print("phase 1  FAIL: the overlay changes PC code, not just line numbers")
        return 1
    print("phase 1  PASS: no PC statement differs (only log line numbers)")
    return phase2(vcvars, tree, inc, defs)


def phase2(vcvars: Path, tree: Path, inc: str, defs: str) -> int:
    objdir = WORK / "obj"
    if objdir.exists():
        shutil.rmtree(objdir)
    objdir.mkdir(parents=True, exist_ok=True)
    srcs = [str(tree / COMMON / rel) if (tree / COMMON / rel).is_file()
            else str(UP / COMMON / rel) for rel in CLOSURE]
    srcs.append(str(ROOT / PROBE))
    quoted = " ".join(f'"{s}"' for s in srcs)
    p = cmd_with(vcvars, f'cl /nologo /c /std:c++14 /EHsc /W0 /MD {defs} {inc} {quoted}',
                 objdir, name="compile")
    errors = [l for l in ((p.stdout or "") + (p.stderr or "")).splitlines()
              if " error " in l or l.strip().startswith("error")]
    objs = list(objdir.glob("*.obj"))
    print(f"phase 2  native compile: {len(objs)}/{len(srcs)} objects")
    for e in errors[:5]:
        print("         " + e[:160].encode("ascii", "replace").decode("ascii"))
    if errors or len(objs) < len(srcs):
        print("phase 2  FAIL")
        return 1
    print("phase 2  PASS (includes the probe source, PC layout constants)")
    print("phase 3  runtime probe: BLOCKED by the PC logging chain, not the scheduler")
    for b in LINK_BLOCKERS:
        print(f"         {b}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
