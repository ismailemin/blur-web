"""Verify that the committed overlay patch reproduces the spike from a fresh tree.

    python engine/verify_overlay.py --fresh          # re-copy upstream first
    python engine/verify_overlay.py                  # reuse _work/engine-overlay-check

Steps:
  1. (--fresh) copy upstream/BlurRebuilt into the tree, excluding .git;
  2. apply engine/patches/t005c-web-scheduler.patch with apply_overlay.py --force;
  3. build the scheduler closure OUT OF THAT TREE (tree include paths only, no
     dependency on _work/engine-web-spike/patched);
  4. run the module twice and the three fail-loud cases, and compare the output
     with the expected A3/A4 lines.

Stdlib only. Reads upstream, writes only inside the tree and _work/logs/.
"""
from __future__ import annotations

import argparse
import hashlib
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))
import apply_overlay as ao  # noqa: E402  (same directory, stdlib only)

UP = ROOT / "upstream/BlurRebuilt"
TREE = ROOT / "_work/engine-overlay-check"
LOGS = ROOT / "_work/logs/engine-web-spike"
EM = ROOT / "_work/toolchains/emsdk/upstream/emscripten/em++.py"
NODE = ROOT / "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"
COMMON = "code/mercury/library/common"
SHIMS = ROOT / "_work/engine-web-spike/shims"

FLAGS = ["-DBUILD_CONFIG_SPEED", "-DPLATFORM_WEB", "-std=c++14", "-O2",
         "-fdelayed-template-parsing", "-D__restrict=", "-fdeclspec",
         "-Wno-nonportable-include-path", "-Wno-ignored-attributes",
         "-include", str(SHIMS / "web_platform.h")]

SCHED_TUS = [
    (f"{COMMON}/system/source/scheduler/jobqueue.cpp", "system"),
    (f"{COMMON}/system/source/scheduler/jobqueue_kernel.cpp", "system"),
    (f"{COMMON}/system/source/scheduler/jobqueue_task_queue_lf.cpp", "system"),
    (f"{COMMON}/system/source/scheduler/jobqueue_mem.cpp", "system"),
    (f"{COMMON}/system/source/scheduler/jobqueue_web.cpp", "system"),
    (f"{COMMON}/core/source/threads/Thread.cpp", "core"),
    (f"{COMMON}/core/source/threads/RwLock.cpp", "core"),
    (f"{COMMON}/core/source/threads/Mutex.cpp", "core"),
    (f"{COMMON}/core/source/threads/Event.cpp", "core"),
    (f"{COMMON}/core/source/allocators/CoreMemoryAligned.cpp", "core"),
    (f"{COMMON}/system/source/time/Time.cpp", "system"),
    (f"{COMMON}/system/source/debug/log/LogManager.cpp", "system"),
    (f"{COMMON}/system/source/debug/log/Logger.cpp", "system"),
    (f"{COMMON}/system/source/debug/log/Format.cpp", "system"),
    (f"{COMMON}/system/source/debug/log/DebugLevel.cpp", "system"),
    (f"{COMMON}/system/source/debug/log/Filter.cpp", "system"),
    (f"{COMMON}/system/source/debug/log/ThreadContext.cpp", "system"),
    (f"{COMMON}/system/source/debug/log/subscribers/ConsoleSubscriber.cpp", "system"),
    (f"{COMMON}/system/source/debug/log/subscribers/SubscriberCommon.cpp", "system"),
    (f"{COMMON}/system/source/debug/log/subscribers/SubscriberManager.cpp", "system"),
    ("_work/engine-web-spike/shims/platform_net_web.cpp", "system"),
    ("_work/engine-web-spike/shims/web_runtime.cpp", "core"),
    ("_work/engine-web-spike/probes/smoke_sched.cpp", "system"),
]

EXPECTED = [
    "policy count=4",
    "step=init",
    "step=start",
    "step=pool",
    "layout queueptr=8/8 paramdata=48 task=72",
    "A4 workers=0 max_workers=0",
    "A4 flush_false ran=1 poll=1",
    "A3 piMed ran=1 observed=1 poll=1",
    "A3 piHigh ran=1 observed=2 poll=1",
    "A3 piOneSPU ran=1 observed=3 poll=1",
    "A3 piStreamer ran=1 observed=4 poll=1",
    "A3 total=4/4",
    "queue queued=0 executing=0",
    "step=shutdown",
]
ABORTS = [("abort-event", "MT::Event::Wait"), ("abort-thread", "tlWaitForThread"),
          ("abort-policy", "all 8 columns are 0")]


def includes(tree: Path, lib: str) -> list[str]:
    if lib == "core":
        dirs = [f"{COMMON}/core/include", f"{COMMON}/core",
                f"{COMMON}/system/include", f"{COMMON}/btl/include"]
    elif lib == "misc":
        dirs = [f"{COMMON}/misc_shared", f"{COMMON}/misc_shared/include",
                f"{COMMON}/btl/include", f"{COMMON}/core/include",
                f"{COMMON}/core", f"{COMMON}/system/include",
                "code/mercury/library/physics/gravity/include", "code/vendor"]
    else:
        dirs = [f"{COMMON}/system", f"{COMMON}/system/include",
                f"{COMMON}/system/source/scheduler", f"{COMMON}/core",
                f"{COMMON}/core/include", f"{COMMON}/btl/include",
                f"{COMMON}/misc_shared/include", f"{COMMON}/xt2/include"]
    return [f"-I{tree / d}" for d in dirs]


# --- the real engine caller: Compression::C_Deflate / C_Inflate -------------
# Deflate.cpp and InflateTask.cpp include
# "../../../../Vendor/Zlib/Current_Mercury/Zlib.h", i.e. they expect the vendored
# zlib headers next to common/. The checkout keeps them at
# code/vendor/zlib/current_mercury, so the tree gets that layout materialised.
VENDOR_HEADERS = ROOT / "upstream/BlurRebuilt/code/vendor/zlib/current_mercury"
VENDOR_ALIAS = Path("code/mercury/library/common/Vendor/Zlib/Current_Mercury")
ZLIB_SRC = ROOT / "upstream/BlurRebuilt/code/vendor/zlib/current_mercury"
ZLIB_C = ["adler32", "crc32", "deflate", "inflate", "inffast", "inftrees",
          "trees", "zutil"]

CALLER_TUS = [
    (f"{COMMON}/misc_shared/source/misc_shared/Compression/Deflate.cpp", "misc"),
    (f"{COMMON}/misc_shared/source/misc_shared/Compression/Inflate.cpp", "misc"),
    (f"{COMMON}/misc_shared/source/misc_shared/Compression/InflateTask.cpp", "misc"),
    ("_work/engine-web-spike/probes/smoke_caller.cpp", "misc"),
]
CALLER_EXPECTED = [
    "caller setup ok",
    "caller deflate deferred=1 ran=1 packed=37 cmf=0x78",
    "caller inflate deferred=1 ran=1 equal=1 text=blur-scheduler-caller-roundtrip",
    "caller shutdown ok",
]


def materialise_vendor(tree: Path) -> int:
    """Copy the vendored zlib headers to the path the engine sources expect."""
    dst = tree / VENDOR_ALIAS
    dst.mkdir(parents=True, exist_ok=True)
    n = 0
    for h in sorted(VENDOR_HEADERS.glob("*.h")):
        shutil.copyfile(h, dst / h.name)
        n += 1
    return n


def run(cmd, cwd: Path | None = None, log: Path | None = None):
    p = subprocess.run([str(c) for c in cmd], cwd=str(cwd or ROOT),
                       capture_output=True, text=True, errors="replace")
    if log is not None:
        log.write_text((p.stdout or "") + (p.stderr or ""), encoding="utf-8")
    return p


def copy_upstream(tree: Path) -> None:
    if tree.exists():
        shutil.rmtree(tree)
    tree.mkdir(parents=True)
    p = run(["robocopy", UP, tree, "/E", "/XD", ".git", "/NFL", "/NDL",
             "/NJH", "/NJS", "/NC", "/NS", "/NP"])
    if p.returncode >= 8:                      # robocopy: <8 means success
        raise SystemExit(f"robocopy failed ({p.returncode}): {p.stdout[-500:]}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tree", default=str(TREE))
    ap.add_argument("--fresh", action="store_true", help="re-copy upstream first")
    args = ap.parse_args()
    tree = Path(args.tree).resolve()
    LOGS.mkdir(parents=True, exist_ok=True)

    if args.fresh or not tree.exists():
        copy_upstream(tree)
    p = run([sys.executable, ROOT / "engine/apply_overlay.py", "--tree", tree, "--force"])
    print((p.stdout or "").strip())
    if p.returncode != 0:
        print(p.stderr, file=sys.stderr)
        return p.returncode

    objdir = ROOT / "_work/engine-web-spike/out/treecheck"
    if objdir.exists():
        shutil.rmtree(objdir)
    objdir.mkdir(parents=True)
    objs = []
    for rel, lib in SCHED_TUS:
        src = (ROOT / rel) if rel.startswith("_work/") else (tree / rel)
        obj = objdir / f"{src.stem}.o"
        p = run([sys.executable, EM, *FLAGS, *includes(tree, lib), "-c", src, "-o", obj],
                log=LOGS / f"treecheck__{src.stem}.log")
        if p.returncode:
            print(f"COMPILE FAILED {rel}", file=sys.stderr)
            print((p.stdout or "") + (p.stderr or ""), file=sys.stderr)
            return 1
        objs.append(obj)

    js = ROOT / "_work/engine-web-spike/out/treecheck/spike_sched_tree.js"
    p = run([sys.executable, EM, *objs, "-sENVIRONMENT=node", "-o", js],
            log=LOGS / "treecheck.link.log")
    if p.returncode:
        print("LINK FAILED", file=sys.stderr)
        return 1

    runs = [run([NODE, js], log=LOGS / f"treecheck.run{i + 1}.log") for i in range(2)]
    out = (runs[0].stdout or "").strip().splitlines()
    missing = [l for l in EXPECTED if l not in out]
    deterministic = runs[0].stdout == runs[1].stdout

    abort_ok = []
    for mode, needle in ABORTS:
        r = run([NODE, js, mode], log=LOGS / f"treecheck.{mode}.log")
        text = (r.stdout or "") + (r.stderr or "")
        abort_ok.append(r.returncode != 0 and needle in text)

    wasm = js.with_suffix(".wasm")
    print(f"objects         {len(objs)}")
    print(f"wasm            {wasm.stat().st_size} B  sha256={hashlib.sha256(wasm.read_bytes()).hexdigest()[:16]}")
    print(f"deterministic   {deterministic}")
    print(f"missing lines   {missing if missing else 'none'}")
    print(f"abort cases     {sum(abort_ok)}/{len(abort_ok)}")

    caller_ok = run_caller(tree, objs, objdir)
    ok = (not missing and deterministic and all(abort_ok)
          and len(out) == len(EXPECTED) and caller_ok)
    print(f"verdict         {'PASS' if ok else 'FAIL'}  (tree {tree})")
    return 0 if ok else 1


def run_caller(tree: Path, sched_objs: list[Path], objdir: Path) -> bool:
    """Build and run the real engine caller (compression classes) on the tree."""
    n = materialise_vendor(tree)
    print(f"vendor alias    {n} headers -> {VENDOR_ALIAS.as_posix()}")

    extra = []
    for rel, lib in CALLER_TUS:
        src = (ROOT / rel) if rel.startswith("_work/") else (tree / rel)
        obj = objdir / f"caller_{src.stem}.o"
        p = run([sys.executable, EM, *FLAGS, *includes(tree, lib), "-c", src, "-o", obj],
                log=LOGS / f"caller__{src.stem}.log")
        if p.returncode:
            print(f"CALLER COMPILE FAILED {rel}", file=sys.stderr)
            print((p.stdout or "")[-1500:], file=sys.stderr)
            return False
        extra.append(obj)

    emcc = EM.with_name("emcc.py")
    cflags = ["-DBUILD_CONFIG_SPEED", "-DPLATFORM_WEB", "-O2",
              "-Wno-nonportable-include-path"]
    for name in ZLIB_C:
        obj = objdir / f"zlib_{name}.o"
        p = run([sys.executable, emcc, *cflags, f"-I{ZLIB_SRC}", f"-I{tree / COMMON}/core/include",
                 "-c", ZLIB_SRC / f"{name}.c", "-o", obj],
                log=LOGS / f"caller__zlib_{name}.log")
        if p.returncode:
            print(f"ZLIB COMPILE FAILED {name}", file=sys.stderr)
            print((p.stdout or "")[-800:], file=sys.stderr)
            return False
        extra.append(obj)

    js = objdir / "spike_caller_tree.js"
    p = run([sys.executable, EM, *sched_objs, *extra, "-sENVIRONMENT=node", "-o", js],
            log=LOGS / "caller.link.log")
    if p.returncode:
        print("CALLER LINK FAILED", file=sys.stderr)
        print((p.stdout or "")[-1500:], file=sys.stderr)
        return False

    runs = [run([NODE, js], log=LOGS / f"caller.run{i + 1}.log") for i in range(2)]
    out = (runs[0].stdout or "").strip().splitlines()
    stable = runs[0].stdout == runs[1].stdout
    missing = [l for l in CALLER_EXPECTED if l not in out]
    wasm = js.with_suffix(".wasm")
    print(f"caller wasm     {wasm.stat().st_size} B  sha256={hashlib.sha256(wasm.read_bytes()).hexdigest()[:16]}")
    for line in out:
        print(f"  out: {line}")
    print(f"caller stable   {stable}")
    print(f"caller missing  {missing if missing else 'none'}")
    return stable and not missing and len(out) == len(CALLER_EXPECTED)


if __name__ == "__main__":
    raise SystemExit(main())
