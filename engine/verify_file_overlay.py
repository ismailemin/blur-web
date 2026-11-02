"""Verify the T-005b file-layer overlay from a fresh upstream copy.

    python engine/verify_file_overlay.py --fresh
    python engine/verify_file_overlay.py                 # reuse the tree
    python engine/verify_file_overlay.py --skip-native    # no MSVC on this host

Gates, in order:
   1. the tree is a fresh copy of upstream/BlurRebuilt (robocopy, no .git);
   2. engine/apply_file_overlay.py applies the scheduler patch and then the file
      patch, refusing a dirty upstream and any tree inside upstream/;
   3. the file patch adds files and modifies none, and `git apply --check`
      accepts it against upstream (the PC-parity statement at diff level);
   4. the wasm32 harness builds from that tree twice; both modules must have the
      same SHA-256 (deterministic build);
   5. the harness runs twice; stdout must be identical, exit code 0, every check
      `pass=1`, and the JS provider must report exactly the expected refusals;
   6. the PAK index read through the ENGINE file layer must equal `range_probe
      pak` field by field, and the range statistics must be identical (same
      window, same request sizes, no coalescing);
   7. both whole-file FNV-1a 64 hashes (direct and buffered Underflow paths)
      must equal an independent Python hash of the same 533 MiB file;
   8. (unless --skip-native) MSVC PC parity: C_FileSystem.cpp and C_File.cpp
      preprocess identically *with* and *without* the three added files, and the
      new C_WebFile.cpp compiles at /W4 in the PC configuration with no warning
      attributed to it and no C_WebFile symbol in the object.

Exit status: 0 pass, 1 fail, 2 blocked (missing fixture/tool, nothing claimed).
Stdlib only. Reads upstream, writes only inside the tree, the log directory and
_work/engine-file-spike/out.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))
import apply_overlay as ao  # noqa: E402  (same directory, stdlib only)

UP = ROOT / "upstream/BlurRebuilt"
TREE = ROOT / "_work/engine-file-spike/tree"
SPIKE = ROOT / "_work/engine-file-spike"
OUT = SPIKE / "out"
LOGS = ROOT / "_work/logs/engine-file-spike"
HARNESS = ROOT / "engine/harness/t005b"
SHIMS = ROOT / "engine/harness/t005c"
EM = ROOT / "_work/toolchains/emsdk/upstream/emscripten/em++.py"
NODE = ROOT / "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"
COMMON = "code/mercury/library/common"
PROBE_SRC = ROOT / "probes/range-file/src"
PAK = ROOT / "game-data/Blur/cache/root.pak"
RANGE_PROBE = ROOT / "_work/range-file-probe/build/range_probe.exe"
FILE_PATCH = ROOT / "engine/patches/t005b-file-overlay.patch"

VCVARS_CANDIDATES = [
    r"C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat",
    r"C:\Program Files\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat",
    r"C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat",
]

HARNESS_FILES = ["smoke_webfile.cpp", "web_file_source.js", "pre.js"]
SHIM_FILES = ["web_platform.h", "crt_compat.h", "web_runtime.cpp", "platform_net_web.cpp"]

FLAGS = [
    "-DBUILD_CONFIG_SPEED", "-DPLATFORM_WEB", "-std=c++14", "-O2",
    "-fdelayed-template-parsing", "-D__restrict=", "-fdeclspec",
    "-Wno-nonportable-include-path", "-Wno-ignored-attributes",
    "-Wno-deprecated-register", "-Wno-return-type", "-Wno-c++20-extensions",
    # The probe parsers report validation failures by throwing and the harness
    # catches them; the engine file layer itself throws nothing.
    "-fexceptions",
    "-include", str(SHIMS / "web_platform.h"),
]

LINK_FLAGS = [
    "-sENVIRONMENT=node", "-sALLOW_MEMORY_GROWTH=1",
    "-sINITIAL_MEMORY=16777216", "-sMAXIMUM_MEMORY=268435456",
    "-sEXIT_RUNTIME=1", "-sNODERAWFS=0",
    "-sDISABLE_EXCEPTION_CATCHING=0",
    "--pre-js", str(HARNESS / "pre.js"),
    "--js-library", str(HARNESS / "web_file_source.js"),
]

# File layer + the logging closure FileOpenError/FileRwError already need (the
# same closure T-005c proved links for wasm32) + the two platform shims.
TUS = [
    (f"{COMMON}/system/source/serialise/C_WebFile.cpp", "system"),
    (f"{COMMON}/system/source/serialise/FileSystemGlobals.cpp", "system"),
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
    (f"{COMMON}/core/source/threads/Thread.cpp", "core"),
    (f"{COMMON}/core/source/threads/RwLock.cpp", "core"),
    (f"{COMMON}/core/source/threads/Mutex.cpp", "core"),
    (f"{COMMON}/core/source/threads/Event.cpp", "core"),
    ("engine/harness/t005c/platform_net_web.cpp", "system"),
    ("engine/harness/t005c/web_runtime.cpp", "core"),
    ("engine/harness/t005b/smoke_webfile.cpp", "system"),
]

PROBE_TUS = ["range_file.cpp", "pak_index_range.cpp"]

EXPECTED_CHECKS = [
    "abi_version", "mount", "mount_async_only", "open", "length_nonzero",
    "index_parse_direct", "open_small_buffer", "open_large_buffer",
    "index_parse_small_buffer", "index_parse_large_buffer",
    "index_paths_agree", "index_paths_agree_with_default",
    "hash_direct", "hash_buffered", "hash_paths_agree",
    "eof_read_fails", "abi_open", "abi_crossing_eof_rejected",
    "abi_past_eof_rejected", "abi_zero_length_rejected",
    "abi_oversize_rejected", "abi_write_refused", "abi_enqueue_refused",
    "exists_mounted", "exists_unmounted", "async_only_read_fails",
    "unmounted_open_refused", "write_open_refused",
    "fileinfo_size", "fileinfo_type", "exists_via_filesystem",
    "directory_info_refused",
]

# Each refusal the provider must emit, with its message marker.
EXPECTED_REFUSALS = 7
REFUSAL_MARKERS = [
    "pf_read_at REJECTED",
    "pf_write_at REJECTED",
    "pf_enqueue_read REJECTED",
    "reason=source has no synchronous store",
]


class Blocked(RuntimeError):
    pass


class Failed(RuntimeError):
    pass


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(cmd, log: Path | None = None, cwd: Path | None = None):
    p = subprocess.run([str(c) for c in cmd], cwd=str(cwd or ROOT),
                       capture_output=True, text=True, errors="replace")
    if log is not None:
        log.parent.mkdir(parents=True, exist_ok=True)
        log.write_text((p.stdout or "") + (p.stderr or ""), encoding="utf-8")
    return p


def fnv1a64_file(path: Path, chunk: int = 1 << 20) -> str:
    h = 0xCBF29CE484222325
    with path.open("rb") as f:
        while True:
            block = f.read(chunk)
            if not block:
                break
            for b in block:
                h ^= b
                h = (h * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return f"{h:016x}"


def require_inputs() -> None:
    missing = []
    if not (UP / ".git").exists():
        missing.append(f"{UP} (a git checkout of the reference source)")
    for name in HARNESS_FILES:
        if not (HARNESS / name).is_file():
            missing.append(f"{HARNESS / name} (spike harness, see engine-file-layer.md)")
    for name in SHIM_FILES:
        if not (SHIMS / name).is_file():
            missing.append(f"{SHIMS / name} (T-005c platform shims)")
    for path in (EM, NODE):
        if not path.is_file():
            missing.append(f"{path} (pinned emsdk)")
    for name in PROBE_TUS:
        if not (PROBE_SRC / name).is_file():
            missing.append(f"{PROBE_SRC / name} (range-file probe sources)")
    if not PAK.is_file():
        missing.append(f"{PAK} (installed reference data)")
    if missing:
        raise Blocked("missing inputs:\n  " + "\n  ".join(missing))


def copy_upstream(tree: Path) -> None:
    if tree.exists():
        shutil.rmtree(tree)
    tree.mkdir(parents=True)
    p = run(["robocopy", UP, tree, "/E", "/XD", ".git", "/NFL", "/NDL",
             "/NJH", "/NJS", "/NC", "/NS", "/NP"], log=LOGS / "copy-upstream.log")
    if p.returncode >= 8:
        raise Failed(f"robocopy failed ({p.returncode}): {(p.stdout or '')[-500:]}")


def structural_check() -> dict:
    files = ao.parse_patch(FILE_PATCH.read_text(encoding="utf-8"))
    modified = [f["rel"] for f in files if not f["is_new"]]
    if modified:
        raise Failed("the file patch modifies existing upstream files: "
                     + ", ".join(modified))
    p = run(["git", "apply", "-p1", "--check", str(FILE_PATCH)], cwd=UP)
    if p.returncode != 0:
        raise Failed(f"git apply --check rejected the patch: {(p.stderr or p.stdout).strip()}")
    return {"files_added": [f["rel"] for f in files], "files_modified": []}


def includes(lib: str) -> list[str]:
    common = TREE / COMMON
    if lib == "core":
        dirs = [common / "core/include", common / "core",
                common / "system/include", common / "btl/include"]
    else:
        dirs = [common / "system", common / "system/include",
                common / "system/source/scheduler", common / "core",
                common / "core/include", common / "btl/include",
                common / "misc_shared/include", common / "xt2/include"]
    out = [f"-I{d}" for d in dirs]
    if lib == "system":
        out.append(f"-I{PROBE_SRC}")
    return out


def build(tag: str) -> Path:
    objdir = OUT / f"obj_{tag}"
    if objdir.exists():
        shutil.rmtree(objdir)
    objdir.mkdir(parents=True)

    objs = []
    for rel, lib in TUS:
        src = (ROOT / rel) if rel.startswith(("_work/", "engine/")) else (TREE / rel)
        obj = objdir / f"{src.stem}.o"
        p = run([sys.executable, EM, *FLAGS, *includes(lib), "-c", src, "-o", obj],
                log=LOGS / f"{tag}__{src.stem}.log")
        if p.returncode:
            raise Failed(f"compile failed: {rel}\n"
                         + ((p.stdout or "") + (p.stderr or ""))[-3000:])
        objs.append(obj)

    for name in PROBE_TUS:
        obj = objdir / f"probe_{name}.o"
        p = run([sys.executable, EM, *FLAGS, f"-I{PROBE_SRC}", "-c", PROBE_SRC / name,
                 "-o", obj], log=LOGS / f"{tag}__probe_{name}.log")
        if p.returncode:
            raise Failed(f"compile failed: probes/range-file/src/{name}\n"
                         + ((p.stdout or "") + (p.stderr or ""))[-3000:])
        objs.append(obj)

    js = OUT / f"webfile_harness_{tag}.js"
    p = run([sys.executable, EM, *objs, *LINK_FLAGS, "-o", js],
            log=LOGS / f"{tag}__link.log")
    if p.returncode:
        raise Failed("link failed\n" + ((p.stdout or "") + (p.stderr or ""))[-3000:])
    return js


def warning_gate() -> dict:
    """No compiler warning may be attributed to the new file itself.

    One diagnostic class is allowed and counted: `-Wignored-qualifiers` on the
    `const bool` / `const C_StreamSize` return types that I_File.h (and C_File.h,
    and FixedString.h, ...) use throughout the engine. The qualifier has no
    effect on a scalar return type, and dropping it here would make the new
    class cosmetically disagree with the interface it implements. Every other
    diagnostic attributed to C_WebFile.cpp/.h is a failure.
    """
    extra = ["-Wall", "-Wextra", "-Wpedantic", "-Wno-unused-parameter"]
    p = run([sys.executable, EM, *FLAGS, *extra, *includes("system"), "-c",
             TREE / COMMON / "system/source/serialise/C_WebFile.cpp",
             "-o", OUT / "warning_gate.o"], log=LOGS / "warning-gate.log")
    if p.returncode:
        raise Failed("warning gate failed to compile C_WebFile.cpp\n"
                     + ((p.stdout or "") + (p.stderr or ""))[-3000:])
    text = (p.stdout or "") + (p.stderr or "")
    ours = [line for line in text.splitlines()
            if re.search(r"C_WebFile\.(?:cpp|h):\d+:\d+: warning:", line)]
    inherited = [line for line in ours if "[-Wignored-qualifiers]" in line]
    other = [line for line in ours if "[-Wignored-qualifiers]" not in line]
    if other:
        raise Failed("warnings attributed to C_WebFile:\n  " + "\n  ".join(other[:10]))
    return {"diagnostics_about_new_file": len(other),
            "const_return_qualifier_warnings": len(inherited)}


def run_harness(js: Path, tag: str) -> dict:
    runs = [run([NODE, js, PAK], log=LOGS / f"{tag}__run{i + 1}.log") for i in range(2)]
    out = runs[0].stdout or ""
    deterministic = runs[0].stdout == runs[1].stdout
    if runs[0].returncode != 0 or runs[1].returncode != 0:
        raise Failed(f"harness exited {runs[0].returncode}/{runs[1].returncode}\n"
                     + (runs[0].stderr or "")[-2000:])
    if not deterministic:
        raise Failed("the two harness runs differ")

    checks = {m.group(1): int(m.group(2))
              for m in re.finditer(r"webfile check (\w+) pass=(\d)", out)}
    missing = [name for name in EXPECTED_CHECKS if name not in checks]
    failed = [name for name, value in checks.items() if value != 1]
    if missing:
        raise Failed("missing checks: " + ", ".join(missing))
    if failed:
        raise Failed("failed checks: " + ", ".join(failed))

    block = re.search(r"---WEBFILE-PAK-JSON-BEGIN---\n(.*?)\n---WEBFILE-PAK-JSON-END---",
                      out, re.S)
    if not block:
        raise Failed("the harness printed no PAK index JSON")
    index = json.loads(block.group(1))

    stats = {}
    for m in re.finditer(r"webfile index (\w+) requests=(\d+) bytes=(\d+) largest=(\d+) "
                         r"window=(\d+) fullFileBytesCopied=(\d+)", out):
        stats[m.group(1)] = {
            "sourceRequests": int(m.group(2)), "bytesRead": int(m.group(3)),
            "largestSourceRequest": int(m.group(4)), "windowBytes": int(m.group(5)),
            "fullFileBytesCopied": int(m.group(6)),
        }
    hashes = dict(re.findall(r"webfile fnv (\w+) hash=0x([0-9a-f]{16})", out))
    counters = {}
    m = re.search(r"webfile counters (.*)", out)
    if m:
        counters = {k: int(v) for k, v in re.findall(r"(\w+)=(\d+)", m.group(1))}

    stderr = runs[0].stderr or ""
    refusals = {}
    for marker in REFUSAL_MARKERS:
        refusals[marker] = stderr.count(marker)
    summary = re.search(r"\[platform/file\] summary (.*)", stderr)
    summary_fields = ({k: int(v) for k, v in re.findall(r"(\w+)=(\d+)", summary.group(1))}
                      if summary else {})
    if not summary:
        raise Failed("the provider printed no summary line")
    if summary_fields.get("failures") != EXPECTED_REFUSALS:
        raise Failed(f"provider refusals {summary_fields.get('failures')} != "
                     f"{EXPECTED_REFUSALS} (an unexpected range was rejected, or one "
                     "of the negative cases stopped being refused)")
    if summary_fields.get("liveHandles") != 0:
        raise Failed("the harness leaked a platform handle")
    if counters.get("abiMismatch") or counters.get("readFailures", 0) != 2:
        raise Failed(f"unexpected engine-layer failures: {counters}")
    for marker in REFUSAL_MARKERS:
        if refusals[marker] < 1:
            raise Failed(f"expected refusal not reported on stderr: {marker}")

    return {
        "checks": checks, "index": index, "stats": stats, "hashes": hashes,
        "counters": counters, "provider_summary": summary_fields,
        "provider_refusals": refusals, "stdout_bytes": len(out),
    }


def compare_reference(result: dict) -> dict:
    if not RANGE_PROBE.is_file():
        raise Blocked(
            f"{RANGE_PROBE} is missing; build probes/range-file first (see "
            "probes/range-file/README.md) - the index comparison is the point of "
            "the check, so it is not skipped")
    p = run([RANGE_PROBE, "pak", PAK], log=LOGS / "range-probe.log")
    if p.returncode != 0:
        raise Failed(f"range_probe failed: {(p.stderr or p.stdout).strip()}")
    reference = json.loads(p.stdout)
    engine = result["index"]

    if engine["header"] != reference["header"]:
        raise Failed("PAK header differs from probes/range-file")
    if len(engine["entries"]) != len(reference["entries"]):
        raise Failed(f"entry count differs: {len(engine['entries'])} vs "
                     f"{len(reference['entries'])}")
    for expected, actual in zip(reference["entries"], engine["entries"]):
        if expected != actual:
            raise Failed(f"PAK entry {expected.get('index')} differs:\n"
                         f"  reference {expected}\n  engine    {actual}")

    # The read sequence itself must be identical, not just the parse result.
    ref_stats = reference["rangeRead"]
    engine_stats = result["stats"]["direct"]
    for key in ("sourceRequests", "bytesRead", "largestSourceRequest",
                "windowBytes", "fullFileBytesCopied"):
        if engine_stats[key] != ref_stats[key]:
            raise Failed(f"range statistic {key} differs: engine {engine_stats[key]} "
                         f"vs reference {ref_stats[key]}")
        if key != "fullFileBytesCopied" and engine_stats[key] != result["stats"]["small_buffer"][key]:
            raise Failed(f"range statistic {key} differs between buffer sizes")
    return {
        "entries": len(engine["entries"]),
        "header": engine["header"],
        "rangeRead": engine_stats,
        "reference_rangeRead": ref_stats,
        "reference_exe_sha256": sha256_file(RANGE_PROBE),
    }


def find_vcvars() -> Path:
    for candidate in VCVARS_CANDIDATES:
        path = Path(candidate)
        if path.is_file():
            return path
    raise Blocked("MSVC vcvars64.bat not found (pass --skip-native to record the gap)")


def bat_step(vcvars: Path, tail: str, name: str) -> subprocess.CompletedProcess:
    work = OUT / "native"
    work.mkdir(parents=True, exist_ok=True)
    bat = work / f"_run_{name}.bat"
    bat.write_text(f'@echo off\r\ncall "{vcvars}" >nul\r\ncd /d "{ROOT}"\r\n{tail}\r\n',
                   encoding="ascii")
    return subprocess.run(["cmd", "/c", str(bat)], capture_output=True, text=True,
                          errors="replace")


def code_lines(path: Path, tree: Path) -> list[str]:
    """Strip `#line` markers, blank lines and the absolute source prefix.

    The only expected difference between the two preprocessed units is the
    directory the sources came from, which appears inside __FILE__ string
    literals (DEBUG_LOCATION). Same rule as engine/native_parity.py."""
    out = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if line.lstrip().startswith("#"):
            continue
        stripped = line.strip()
        if not stripped:
            continue
        stripped = stripped.replace(str(UP), "<SRC>").replace(str(tree), "<SRC>")
        stripped = stripped.replace(UP.as_posix(), "<SRC>").replace(tree.as_posix(), "<SRC>")
        out.append(stripped)
    return out


def preprocess(vcvars: Path, src: Path, out: Path, inc: str, defs: str, name: str) -> Path:
    work = OUT / "native"
    p = bat_step(vcvars, f'cl /nologo /P /C /std:c++14 /EHsc {defs} {inc} '
                         f'/Fi"{out}" "{src}"', name)
    if p.returncode != 0 or not out.is_file():
        raise Failed(f"preprocessing {src.name} failed: {(p.stdout or '')[-1500:]}")
    return out


def native_parity(tree: Path, added: list[str]) -> dict:
    """Prove the file patch cannot change a PC translation unit.

    The overlay is applied on top of the scheduler overlay, so upstream vs tree
    would also show the scheduler's own grammar fixes (map.h, sortedbinarytree.h)
    and say nothing about this patch. The A/B is therefore *with* and *without*
    the three new files: preprocess C_FileSystem.cpp and C_File.cpp, delete the
    three files, preprocess again, then restore them by re-applying the overlay.
    Identical units mean the PC build cannot see the file layer at all.
    """
    vcvars = find_vcvars()
    work = OUT / "native"
    work.mkdir(parents=True, exist_ok=True)

    inc = " ".join(f'/I"{tree / p}"' for p in (
        f"{COMMON}/core/include", f"{COMMON}/core", f"{COMMON}/system",
        f"{COMMON}/system/include", f"{COMMON}/btl/include",
        f"{COMMON}/misc_shared/include", f"{COMMON}/misc_shared",
        f"{COMMON}/xt2/include", f"{COMMON}/system/source/scheduler"))
    defs = "/DBUILD_CONFIG_SPEED /DPLATFORM_PC /DWIN32 /D_WINDOWS"

    units = ("system/source/serialise/C_FileSystem.cpp",
             "system/source/serialise/C_File.cpp")

    with_files = {}
    for rel in units:
        out = work / f"with_{Path(rel).stem}.i"
        preprocess(vcvars, tree / COMMON / rel, out, inc, defs, f"pp_with_{Path(rel).stem}")
        with_files[rel] = out

    without_files = {}
    try:
        for rel in added:
            path = tree / rel
            if path.exists():
                path.unlink()
        for rel in units:
            out = work / f"without_{Path(rel).stem}.i"
            preprocess(vcvars, tree / COMMON / rel, out, inc, defs,
                       f"pp_without_{Path(rel).stem}")
            without_files[rel] = out
    finally:
        p = run([sys.executable, ROOT / "engine/apply_file_overlay.py", "--tree", tree],
                log=LOGS / "apply-after-native.log")
        if p.returncode != 0:
            raise Failed("could not restore the tree after the A/B check: "
                         + (p.stderr or p.stdout).strip())

    identical = {}
    for rel in units:
        a = code_lines(with_files[rel], tree)
        b = code_lines(without_files[rel], tree)
        if a != b:
            raise Failed(f"the file layer changes the PC translation unit of {rel} "
                         f"({len(a)} vs {len(b)} non-blank lines)")
        identical[rel] = len(a)

    # The new TU must be inert in the PC configuration: it compiles, warns
    # nothing at /W4, and contributes no C_WebFile symbol.
    obj = work / "C_WebFile_pc.obj"
    src = tree / COMMON / "system/source/serialise/C_WebFile.cpp"
    p = bat_step(vcvars, f'cl /nologo /c /W4 /std:c++14 /EHsc {defs} {inc} '
                         f'/Fo"{obj}" "{src}"', "pc_webfile")
    if p.returncode != 0:
        raise Failed("MSVC /W4 compile of C_WebFile.cpp failed in the PC configuration\n"
                     + (p.stdout or "")[-2000:])
    warnings = [line for line in (p.stdout or "").splitlines()
                if re.search(r"C_WebFile\.(?:cpp|h)\(\d+\)\s*:\s*warning C", line)]
    if warnings:
        raise Failed("MSVC /W4 warnings on C_WebFile.cpp:\n  " + "\n  ".join(warnings[:10]))
    p = bat_step(vcvars, f'dumpbin /nologo /symbols "{obj}"', "dumpbin")
    if p.returncode == 0 and "@C_WebFile@" in (p.stdout or ""):
        raise Failed("the PC object of C_WebFile.cpp exports C_WebFile symbols")
    return {
        "approach": "preprocess with and without the three added files",
        "preprocessed_identical": identical,
        "pc_w4_compile": "clean",
        "pc_object_has_mangled_symbols": False,
        "pc_object_bytes": obj.stat().st_size if obj.is_file() else 0,
        "vcvars": str(vcvars),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tree", default=str(TREE))
    ap.add_argument("--fresh", action="store_true", help="re-copy upstream first")
    ap.add_argument("--skip-native", action="store_true",
                    help="skip the MSVC PC parity gate and record why")
    ap.add_argument("--report", default=str(LOGS / "verify-summary.json"))
    args = ap.parse_args()

    tree = Path(args.tree).resolve()
    if tree == UP.resolve() or UP.resolve() in tree.parents:
        raise Failed(f"refusing a tree inside upstream ({tree}); "
                     "the reference checkout must never be written to")
    LOGS.mkdir(parents=True, exist_ok=True)
    OUT.mkdir(parents=True, exist_ok=True)
    started = time.time()
    report: dict = {"purpose": "T-005b file-layer verification"}

    require_inputs()

    if args.fresh or not tree.exists():
        copy_upstream(tree)
        report["tree"] = "fresh copy of upstream"
    else:
        report["tree"] = "reused"

    p = run([sys.executable, ROOT / "engine/apply_file_overlay.py", "--tree", tree],
            log=LOGS / "apply.log")
    print((p.stdout or "").strip())
    if p.returncode != 0:
        raise Failed((p.stderr or p.stdout).strip())
    report["apply"] = json.loads((tree / ".overlay/file-overlay.json").read_text())
    report["patch_sha256"] = sha256_file(FILE_PATCH)

    report["structure"] = structural_check()

    first = build("a")
    second = build("b")
    hash_a = sha256_file(first.with_suffix(".wasm"))
    hash_b = sha256_file(second.with_suffix(".wasm"))
    if hash_a != hash_b:
        raise Failed(f"the build is not deterministic: {hash_a[:16]} != {hash_b[:16]}")
    report["wasm"] = {
        "bytes": first.with_suffix(".wasm").stat().st_size,
        "sha256": hash_a,
        "rebuild_sha256": hash_b,
        "deterministic": True,
        "objects": len(TUS) + len(PROBE_TUS),
    }

    report["warning_gate"] = warning_gate()

    result = run_harness(first, "a")
    report["harness"] = result
    report["reference"] = compare_reference(result)

    python_hash = fnv1a64_file(PAK)
    if set(result["hashes"]) != {"direct", "buffered"}:
        raise Failed(f"unexpected hash set: {sorted(result['hashes'])}")
    for path, value in result["hashes"].items():
        if value != python_hash:
            raise Failed(f"FNV-1a 64 mismatch ({path}): {value} != {python_hash}")
    report["whole_file"] = {
        "path": str(PAK.relative_to(ROOT)),
        "bytes": PAK.stat().st_size,
        "fnv1a64": python_hash,
        "engine_paths": result["hashes"],
    }

    if args.skip_native:
        report["pc_parity"] = {"skipped": True,
                               "reason": "--skip-native was passed; no MSVC check ran"}
    else:
        report["pc_parity"] = native_parity(tree, report["structure"]["files_added"])

    report["elapsed_seconds"] = round(time.time() - started, 1)
    report["verdict"] = "PASS"
    Path(args.report).write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

    print(f"patch           sha256={report['patch_sha256'][:16]}")
    print(f"files           {len(report['structure']['files_added'])} added, 0 modified")
    print(f"objects         {report['wasm']['objects']}")
    print(f"wasm            {report['wasm']['bytes']} B sha256={report['wasm']['sha256'][:16]} "
          f"deterministic={report['wasm']['deterministic']}")
    print(f"harness         {len(result['checks'])}/{len(EXPECTED_CHECKS)} checks pass, "
          f"refusals={result['provider_summary'].get('failures')}")
    print(f"index           {report['reference']['entries']} entries, "
          f"requests={report['reference']['rangeRead']['sourceRequests']}, "
          f"bytes={report['reference']['rangeRead']['bytesRead']}")
    print(f"fnv1a64         {python_hash} (both paths)")
    if report["pc_parity"].get("skipped"):
        print("pc parity       SKIPPED (recorded)")
    else:
        print("pc parity       preprocessed TUs identical, /W4 clean, no PC symbols")
    print(f"report          {args.report}")
    print(f"verdict         PASS  ({report['elapsed_seconds']} s)")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Blocked as exc:
        print(f"verify_file_overlay: BLOCKED: {exc}", file=sys.stderr)
        raise SystemExit(2)
    except Failed as exc:
        print(f"verify_file_overlay: FAIL: {exc}", file=sys.stderr)
        raise SystemExit(1)
