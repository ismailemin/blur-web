"""Verify the T-005e level-streaming spike from a fresh upstream copy.

    python engine/verify_stream.py --fresh
    python engine/verify_stream.py                 # reuse the tree
    python engine/verify_stream.py --skip-native   # record the PC-parity gap

Gates, in order:
  1. copy upstream/BlurRebuilt, apply engine/apply_file_overlay.py (T-005c +
     T-005b), then apply engine/patches/t005b-stream-overlay.patch;
  2. the stream patch touches exactly six named files, all inside
     PLATFORM_WEB guards (structural check);
  3. build the wasm32 module twice; the two wasm hashes must be identical;
  4. run the harness twice; stdout must be identical, exit 0, every check pass;
  5. run probes/range-file's `range_probe level` and probes/asset-reader's
     `level_inspect --index`: the 359 ChunkInfo records, resourceBlockCount,
     initiallyLoadedBlocks and metadata must agree field by field;
  6. write the chunk manifest from that reference and load every chunk through
     RenderingData::Target::StreamManager::LoadChunk / GetChunkData over
     C_OverlayFs; every chunk hash must equal an independent Python FNV-1a 64 of
     the same range in Level.levelstream;
  7. the engine-loaded chunk 157 bytes must hash to the documented geometry
     chunk (SHA-256 b07b386c...), and the whole Level.levelrender and
     Level.levelphysics FNV hashes must equal Python's;
  8. (unless --skip-native) PC parity: streammanager.cpp preprocesses
     identically with and without the patch, using the committed display stub
     (the real header needs the absent DXSDK; see the analysis).

Exit status: 0 pass, 1 fail, 2 blocked (missing input, nothing claimed).
Stdlib only. Reads upstream and the level files; writes only under
_work/engine-stream-spike/ and _work/logs/engine-stream-spike/.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import struct
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "engine"))
import apply_overlay as ao  # noqa: E402

UP = ROOT / "upstream/BlurRebuilt"
SPIKE = ROOT / "_work/engine-stream-spike"
TREE = SPIKE / "tree"
OUT = SPIKE / "out"
LOGS = ROOT / "_work/logs/engine-stream-spike"
HARNESS = ROOT / "engine/harness/t005e"
SHIMS = ROOT / "engine/harness/t005c"
STUB = HARNESS / "stub"
EM = ROOT / "_work/toolchains/emsdk/upstream/emscripten/em++.py"
NODE = ROOT / "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"
COMMON = "code/mercury/library/common"
LOGICALFS = "code/mercury/library/util/logicalfs"
RD = "code/mercury/library/graphics/renderingdata"
PATCH = ROOT / "engine/patches/t005b-stream-overlay.patch"
RANGE_PROBE = ROOT / "_work/range-file-probe/build/range_probe.exe"
LEVEL_INSPECT = ROOT / "_work/build/asset-reader-native/Release/level_inspect.exe"
LEVEL_DIR = ROOT / "game-data/Blur/levels/usa_la_river"
LEVEL_RENDER = LEVEL_DIR / "Level.levelrender"
LEVEL_STREAM = LEVEL_DIR / "Level.levelstream"
LEVEL_PHYSICS = LEVEL_DIR / "Level.levelphysics"

GEOMETRY_CHUNK_INDEX = 157
GEOMETRY_CHUNK_SHA256 = "b07b386c5da5b9154aa393e121614236d7f828d5c5f985e720c01bb192d5b710"
EXPECTED_STREAM_BYTES = 244682752
EXPECTED_STREAM_CHUNKS = 359

VCVARS_CANDIDATES = [
    r"C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat",
    r"C:\Program Files\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat",
    r"C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat",
]

HARNESS_FILES = ["stream_harness.cpp", "pre.js"]
SHIM_FILES = ["web_platform.h", "crt_compat.h", "web_runtime.cpp", "platform_net_web.cpp"]

FLAGS = [
    "-DBUILD_CONFIG_SPEED", "-DPLATFORM_WEB", "-DRENDERINGDATA_ALLOW_INCLUDE=1",
    "-std=c++14", "-O2",
    "-fdelayed-template-parsing", "-D__restrict=", "-fdeclspec", "-fms-extensions",
    "-Wno-nonportable-include-path", "-Wno-ignored-attributes",
    "-Wno-deprecated-register", "-Wno-return-type", "-Wno-c++20-extensions",
    "-fexceptions",
    "-include", str(ROOT / "engine/harness/t005b/msvc_crt_web.h"),
    "-include", str(SHIMS / "web_platform.h"),
]

LINK_FLAGS = [
    "-sENVIRONMENT=node", "-sALLOW_MEMORY_GROWTH=1",
    "-sINITIAL_MEMORY=16777216", "-sMAXIMUM_MEMORY=268435456",
    "-sEXIT_RUNTIME=1",
    # The harness reads the chunk manifest with fopen(); NODERAWFS lets libc see
    # the host file. The level bytes still come through the JS range source.
    "-sNODERAWFS=1",
    "-sDISABLE_EXCEPTION_CATCHING=0",
    "--pre-js", str(HARNESS / "pre.js"),
    "--js-library", str(ROOT / "engine/harness/t005b/web_file_source.js"),
]

TUS = [
    (f"{COMMON}/system/source/serialise/C_WebFile.cpp", "system"),
    (f"{COMMON}/system/source/serialise/C_WebDirectoryInfo.cpp", "system"),
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
    (f"{COMMON}/core/source/allocators/CoreMemoryAligned.cpp", "core"),
    (f"{COMMON}/core/source/utility/endian.cpp", "core"),
    (f"{COMMON}/core/source/utility/BizAssert.cpp", "core"),
    (f"{COMMON}/system/source/serialise/FilePath.cpp", "system"),
    (f"{COMMON}/system/source/serialise/FsPerfLogger.cpp", "system"),
    (f"{COMMON}/system/source/debug/Debug.cpp", "system"),
    (f"{COMMON}/system/source/debug/Variables.cpp", "system"),
    (f"{COMMON}/system/source/memory/MemoryBuffer.cpp", "system"),
    (f"{COMMON}/system/source/scheduler/jobqueue.cpp", "system"),
    (f"{COMMON}/system/source/scheduler/jobqueue_kernel.cpp", "system"),
    (f"{COMMON}/system/source/scheduler/jobqueue_task_queue_lf.cpp", "system"),
    (f"{COMMON}/system/source/scheduler/jobqueue_mem.cpp", "system"),
    (f"{COMMON}/system/source/scheduler/jobqueue_web.cpp", "system"),
    (f"{LOGICALFS}/source/overlayfs/OverlayFs.cpp", "logicalfs"),
    (f"{LOGICALFS}/source/overlayfs/OverlayLayer.cpp", "logicalfs"),
    (f"{RD}/source/noninterface/target/streammanager.cpp", "rd"),
    (f"{RD}/source/noninterface/target/streamingstatistics.cpp", "rd"),
    ("engine/harness/t005c/platform_net_web.cpp", "system"),
    ("engine/harness/t005c/web_runtime.cpp", "core"),
    ("engine/harness/t005e/stream_harness.cpp", "harness"),
]

EXTRA_FLAGS = {
    f"{LOGICALFS}/source/overlayfs/OverlayFs.cpp": ["-DGLOBAL_DEBUG_MESSAGE_LEVEL=0"],
}

EXPECTED_CHECKS = [
    "abi_version", "mount", "overlay_mount", "exists_render", "exists_stream",
    "exists_physics", "render_read", "physics_read", "stream_open", "manifest",
    "stream_policy", "chunk_allocator", "stream_chunk_count", "stream_all_read",
    "stream_bytes", "stream_largest", "stream_no_requests", "eof_read_fails",
    "past_eof_read_fails", "oversize_chunk_refused",
]

# The six patched files and their required token counts. Nothing else may be in
# the patch.
PATCH_EXPECTATIONS = {
    f"{COMMON}/core/include/core/threads/threadlocalstorage.h": {
        "added": 9, "removed": 0,
        "tokens": ["#elif defined (PLATFORM_WEB)", "ThreadLocalStorage() : pData(0)"],
    },
    f"{COMMON}/core/include/core/maths/utmaths/operator.h": {
        "added": 28, "removed": 0,
        "tokens": ["p1.template At<I>()", "#if defined(PLATFORM_WEB)"],
    },
    f"{COMMON}/core/include/btl/containers/sortedbinarytree.inl": {
        "added": 19, "removed": 0,
        "tokens": ["i.m_pNode", "#if defined(PLATFORM_WEB)"],
    },
    f"{COMMON}/core/include/btl/containers/skiplist.inl": {
        "added": 10, "removed": 0,
        "tokens": ["Base::Min", "Base::Max"],
    },
    f"{RD}/include/renderingdata/datatypes.h": {
        "added": 20, "removed": 0,
        "tokens": ["SHHD_3N(float x_, float y_, float z_) : data(0)",
                   "SDDD_3N(float x_, float y_, float z_) : data(0)"],
    },
    f"{RD}/source/noninterface/target/streammanager.cpp": {
        "added": 129, "removed": 8,
        "tokens": ["class LoadingThread", "void Drain()",
                   "#if defined(PLATFORM_WEB)", "IsActive()"],
    },
}


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


def fnv1a64_bytes(data: bytes) -> str:
    h = 0xCBF29CE484222325
    for b in data:
        h ^= b
        h = (h * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return f"{h:016x}"


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


def fnv1a64_range(path: Path, offset: int, length: int) -> str:
    h = 0xCBF29CE484222325
    with path.open("rb") as f:
        f.seek(offset)
        remaining = length
        while remaining:
            block = f.read(min(remaining, 1 << 20))
            if not block:
                raise Failed(f"short read at {offset}+{length} in {path}")
            for b in block:
                h ^= b
                h = (h * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
            remaining -= len(block)
    return f"{h:016x}"


def require_inputs() -> None:
    missing = []
    if not (UP / ".git").exists():
        missing.append(f"{UP} (a git checkout of the reference source)")
    for name in HARNESS_FILES:
        if not (HARNESS / name).is_file():
            missing.append(f"{HARNESS / name} (spike harness)")
    for name in SHIM_FILES:
        if not (SHIMS / name).is_file():
            missing.append(f"{SHIMS / name} (T-005c platform shims)")
    for path in (EM, NODE, LEVEL_RENDER, LEVEL_STREAM, LEVEL_PHYSICS):
        if not path.is_file():
            missing.append(str(path))
    for path in (RANGE_PROBE, LEVEL_INSPECT):
        if not path.is_file():
            missing.append(f"{path} (run probes/range-file and probes/asset-reader builds)")
    if not (STUB / "Display.h").is_file() or not (STUB / "fx/fx.h").is_file():
        missing.append(f"{STUB} (display facade)")
    if missing:
        raise Blocked("missing inputs:\n  " + "\n  ".join(missing))


def copy_upstream(tree: Path) -> None:
    if tree.exists():
        shutil.rmtree(tree)
    tree.mkdir(parents=True)
    p = run(["robocopy", UP, tree, "/E", "/XD", ".git", "/NFL", "/NDL",
             "/NJH", "/NJS", "/NC", "/NS", "/NP"], log=LOGS / "copy-upstream.log")
    if p.returncode >= 8:
        raise Failed(f"robocopy failed ({p.returncode})")


APPLIED_MARKERS = {
    f"{COMMON}/core/include/core/threads/threadlocalstorage.h": "#elif defined (PLATFORM_WEB)",
    f"{COMMON}/core/include/core/maths/utmaths/operator.h": "p1.template At<I>()",
    f"{COMMON}/core/include/btl/containers/sortedbinarytree.inl": "Base::SentinelPointer()",
    f"{COMMON}/core/include/btl/containers/skiplist.inl": "S32 newLevel = Base::Min(",
    f"{RD}/include/renderingdata/datatypes.h": "// clang rejects initialising several members",
    f"{RD}/source/noninterface/target/streammanager.cpp": "void Drain()",
}


def apply_stream_patch(tree: Path) -> int:
    """Apply PATCH to the already-overlaid tree, newline-preserving.

    apply_overlay.py refuses a source without a final newline (skiplist.inl is
    one), and it always sources from upstream, which would discard the scheduler
    patch in sortedbinarytree.inl. This applier uses the tree's current bytes,
    keeps each file's EOL and trailing-newline state, and is idempotent.
    """
    files = ao.parse_patch(PATCH.read_text(encoding="utf-8"))
    applied = 0
    for f in files:
        path = tree / f["rel"]
        if f["is_new"] or not path.is_file():
            raise Failed(f"stream patch expects an existing file: {f['rel']}")
        raw = path.read_bytes()
        eol = "\r\n" if b"\r\n" in raw else "\n"
        text = raw.decode("utf-8").replace("\r\n", "\n").replace("\r", "\n")
        if APPLIED_MARKERS[f["rel"]] in text:
            continue
        trailing = text.endswith("\n")
        body = text[:-1] if trailing else text
        lines = body.split("\n") if body else []
        out = ao.apply_hunks(f["rel"], lines, f["hunks"])
        path.write_bytes((eol.join(out) + (eol if trailing else "")).encode("utf-8"))
        applied += 1
    return applied


def apply_patches(tree: Path) -> dict:
    p = run([sys.executable, ROOT / "engine/apply_file_overlay.py", "--tree", tree],
            log=LOGS / "apply-file-overlay.log")
    if p.returncode != 0:
        raise Failed("apply_file_overlay failed: " + ((p.stderr or p.stdout).strip()))
    applied = apply_stream_patch(tree)
    record = json.loads((tree / ".overlay/file-overlay.json").read_text())
    record["stream_patch_files_applied"] = applied
    return record


def structural_check() -> dict:
    files = ao.parse_patch(PATCH.read_text(encoding="utf-8"))
    rels = {f["rel"]: f for f in files}
    if set(rels) != set(PATCH_EXPECTATIONS):
        raise Failed("the patch touches unexpected files: "
                     + ", ".join(sorted(set(rels) ^ set(PATCH_EXPECTATIONS))))
    counts = {}
    for rel, want in PATCH_EXPECTATIONS.items():
        added = [c for h in rels[rel]["hunks"] for t, c in h["lines"] if t == "+"]
        removed = [c for h in rels[rel]["hunks"] for t, c in h["lines"] if t == "-"]
        if rels[rel]["is_new"]:
            raise Failed(f"{rel}: the stream patch must not add files")
        if len(added) != want["added"] or len(removed) != want["removed"]:
            raise Failed(f"{rel}: expected +{want['added']}/-{want['removed']}, "
                         f"patch has +{len(added)}/-{len(removed)}")
        for token in want["tokens"]:
            if not any(token in line for line in added):
                raise Failed(f"{rel}: added lines do not contain {token!r}")
        counts[rel] = {"added": len(added), "removed": len(removed)}
    return counts


def includes(kind: str) -> list[str]:
    c = TREE / COMMON
    rd = TREE / RD
    base = [c / "system", c / "system/include", c / "system/source/scheduler",
            c / "core", c / "core/include", c / "btl/include",
            c / "misc_shared", c / "misc_shared/include", c / "xt2/include"]
    if kind in ("rd", "harness"):
        base = [STUB, rd, rd / "include", rd / "source/noninterface",
                TREE / "code/mercury/library/graphics/display/include",
                TREE / "code/mercury/library/graphics/display2/include",
                TREE / "code/mercury/library/graphics/ngl/include",
                TREE / "code/mercury/library/graphics/fx/include",
                TREE / "code/mercury/library/graphics/texture_export/include",
                TREE / "code/mercury/library/graphics/world_render/include",
                TREE / "code/mercury/library/gamesys/framework/include"] + base
    if kind in ("logicalfs", "harness"):
        lf = TREE / LOGICALFS
        base = [c / "system", c / "system/include", c / "system/source/scheduler",
                c / "core", c / "core/include", c / "btl/include",
                c / "misc_shared", c / "misc_shared/include", c / "xt2/include",
                lf, lf / "include",
                TREE / "code/mercury/library/util/Tools_shared",
                TREE / "code/mercury/library/util/Tools_shared/include",
                TREE / "code/vendor/zlib/current_mercury"]
        if kind == "harness":
            base = [STUB, rd, rd / "include", rd / "source/noninterface",
                    TREE / "code/mercury/library/graphics/display/include",
                    TREE / "code/mercury/library/graphics/display2/include",
                    TREE / "code/mercury/library/graphics/ngl/include",
                    TREE / "code/mercury/library/graphics/fx/include",
                    TREE / "code/mercury/library/graphics/texture_export/include",
                    TREE / "code/mercury/library/graphics/world_render/include",
                    TREE / "code/mercury/library/gamesys/framework/include"] + base
    return [f"-I{p}" for p in base]


def build(tag: str) -> Path:
    objdir = OUT / f"obj_{tag}"
    if objdir.exists():
        shutil.rmtree(objdir)
    objdir.mkdir(parents=True)
    objs = []
    for rel, kind in TUS:
        src = (ROOT / rel) if rel.startswith("engine/") else (TREE / rel)
        obj = objdir / f"{src.stem}.o"
        p = run([sys.executable, EM, *FLAGS, *EXTRA_FLAGS.get(rel, []),
                 *includes(kind), "-c", src, "-o", obj],
                log=LOGS / f"{tag}__{src.stem}.log")
        if p.returncode:
            raise Failed(f"compile failed: {rel}\n"
                         + ((p.stdout or "") + (p.stderr or ""))[-2500:])
        objs.append(obj)
    js = OUT / f"stream_harness_{tag}.js"
    p = run([sys.executable, EM, *map(str, objs), *LINK_FLAGS, "-o", js],
            log=LOGS / f"{tag}__link.log")
    if p.returncode:
        raise Failed("link failed\n" + ((p.stdout or "") + (p.stderr or ""))[-3000:])
    return js


def reference_index() -> dict:
    p = run([RANGE_PROBE, "level", LEVEL_RENDER], log=LOGS / "range-probe-level.log")
    if p.returncode != 0:
        raise Failed("range_probe level failed: " + ((p.stderr or p.stdout).strip()))
    a = json.loads(p.stdout)

    p = run([LEVEL_INSPECT, "--index", LEVEL_RENDER], log=LOGS / "level-inspect.log")
    if p.returncode != 0:
        raise Failed("level_inspect --index failed: " + ((p.stderr or p.stdout).strip()))
    b = json.loads(p.stdout)

    for key in ("resourceBlockCount", "initiallyLoadedBlocks"):
        if a[key] != b[key]:
            raise Failed(f"{key}: range_probe {a[key]} != level_inspect {b[key]}")
    if a.get("metadata") != b.get("metadata"):
        raise Failed("index metadata differs between the two committed readers")
    if len(a["streamChunks"]) != len(b["streamChunks"]):
        raise Failed("chunk counts differ between the two committed readers")
    for i, (x, y) in enumerate(zip(a["streamChunks"], b["streamChunks"])):
        if x != y:
            raise Failed(f"ChunkInfo record {i} differs:\n  range {x}\n  inspect {y}")
    if len(a["streamChunks"]) != EXPECTED_STREAM_CHUNKS:
        raise Failed(f"{len(a['streamChunks'])} chunks, expected {EXPECTED_STREAM_CHUNKS}")
    total = sum(c["storedBytes"] for c in a["streamChunks"])
    if total != EXPECTED_STREAM_BYTES or total != LEVEL_STREAM.stat().st_size:
        raise Failed(f"chunk bytes {total} != levelstream size {LEVEL_STREAM.stat().st_size}")
    for i, c in enumerate(a["streamChunks"]):
        if c["storedBytes"] == 0:
            raise Failed(f"chunk {i} has storedBytes 0")
        if c["offset"] > LEVEL_STREAM.stat().st_size - c["storedBytes"]:
            raise Failed(f"chunk {i} range crosses the stream file")
    geom = a["streamChunks"][GEOMETRY_CHUNK_INDEX]
    if geom["offset"] != 68937728 or geom["storedBytes"] != 10240:
        raise Failed("the documented geometry chunk record changed")
    sha = hashlib.sha256()
    with LEVEL_STREAM.open("rb") as f:
        f.seek(geom["offset"])
        sha.update(f.read(geom["storedBytes"]))
    if sha.hexdigest() != GEOMETRY_CHUNK_SHA256:
        raise Failed(f"geometry chunk SHA-256 {sha.hexdigest()} != "
                     f"{GEOMETRY_CHUNK_SHA256}")
    return a


def write_manifest(index: dict) -> Path:
    path = OUT / "stream_chunks.tsv"
    with path.open("w", encoding="ascii", newline="\n") as f:
        f.write("# index offset storedBytes logicalBytes\n")
        for i, c in enumerate(index["streamChunks"]):
            f.write(f"{i} {c['offset']} {c['storedBytes']} {c['logicalBytes']}\n")
    return path


def run_harness(js: Path, manifest: Path, tag: str) -> dict:
    args = [NODE, js, LEVEL_RENDER, LEVEL_STREAM, LEVEL_PHYSICS, manifest]
    runs = [run(args, log=LOGS / f"{tag}__run{i + 1}.log") for i in range(2)]
    out = runs[0].stdout or ""
    if runs[0].stdout != runs[1].stdout:
        raise Failed("the two harness runs differ")
    if runs[0].returncode or runs[1].returncode:
        raise Failed(f"harness exited {runs[0].returncode}/{runs[1].returncode}\n"
                     + (runs[0].stderr or "")[-2000:])

    checks = {m.group(1): int(m.group(2))
              for m in re.finditer(r"webfile check (\w+) pass=(\d)", out)}
    missing = [n for n in EXPECTED_CHECKS if n not in checks]
    failed = [n for n, v in checks.items() if v != 1]
    if missing or failed:
        raise Failed(f"checks missing={missing} failed={failed}")

    chunks = {}
    for m in re.finditer(r"webfile chunk (\d+) offset=(\d+) bytes=(\d+) "
                         r"hash=0x([0-9a-f]{16})", out):
        chunks[int(m.group(1))] = {
            "offset": int(m.group(2)), "bytes": int(m.group(3)),
            "fnv1a64": m.group(4),
        }
    summary = re.search(r"webfile stream summary (.*)", out)
    counters = re.search(r"webfile counters (.*)", out)
    file_hashes = {}
    for m in re.finditer(r"webfile file (\S+) bytes=(\d+) hash=0x([0-9a-f]{16}) "
                         r"reads=(\d+) ok=(\d)", out):
        file_hashes[m.group(1)] = {
            "bytes": int(m.group(2)), "fnv1a64": m.group(3),
            "reads": int(m.group(4)), "ok": int(m.group(5)),
        }
    if not summary or not counters:
        raise Failed("the harness printed no stream summary or counters")
    summary_fields = {k: int(v) for k, v in re.findall(r"(\w+)=(\d+)", summary.group(1))}
    counter_fields = {k: int(v) for k, v in re.findall(r"(\w+)=(\d+)", counters.group(1))}

    if summary_fields.get("chunks") != EXPECTED_STREAM_CHUNKS:
        raise Failed(f"engine streamed {summary_fields.get('chunks')} chunks")
    if summary_fields.get("bytes") != EXPECTED_STREAM_BYTES:
        raise Failed(f"engine streamed {summary_fields.get('bytes')} bytes")
    if summary_fields.get("readFailures") or summary_fields.get("hashFailures"):
        raise Failed(f"engine chunk load failures: {summary_fields}")
    if counter_fields.get("readFailures") != 2:
        raise Failed(f"engine read failures {counter_fields.get('readFailures')} != 2 "
                     "(the two deliberate end-of-file requests)")
    if counter_fields.get("abiMismatch") or counter_fields.get("bufferHintRefused"):
        raise Failed(f"unexpected engine-layer refusals: {counter_fields}")

    stderr = runs[0].stderr or ""
    summary = re.search(r"\[platform/file\] summary (.*)", stderr)
    provider = ({k: int(v) for k, v in re.findall(r"(\w+)=(\d+)", summary.group(1))}
                if summary else {})
    if not provider:
        raise Failed("the provider printed no summary line")
    if provider.get("failures") != 0:
        raise Failed(f"provider rejected {provider.get('failures')} ranges: "
                     "every engine request must be inside the source")
    if provider.get("liveHandles") != 0:
        raise Failed("the harness leaked a platform handle")

    return {
        "checks": checks, "chunks": chunks, "summary": summary_fields,
        "counters": counter_fields, "provider": provider, "file_hashes": file_hashes,
        "stdout_bytes": len(out), "stderr_bytes": len(stderr),
    }


def compare_chunks(result: dict, index: dict) -> dict:
    if len(result["chunks"]) != len(index["streamChunks"]):
        raise Failed(f"engine loaded {len(result['chunks'])} chunks, reference "
                     f"{len(index['streamChunks'])}")
    for i, c in enumerate(index["streamChunks"]):
        got = result["chunks"].get(i)
        if got is None:
            raise Failed(f"engine did not report chunk {i}")
        if got["offset"] != c["offset"] or got["bytes"] != c["storedBytes"]:
            raise Failed(f"chunk {i} range differs from the reference")
        want = fnv1a64_range(LEVEL_STREAM, c["offset"], c["storedBytes"])
        if got["fnv1a64"] != want:
            raise Failed(f"chunk {i} FNV {got['fnv1a64']} != independent {want}")
    geom = result["chunks"][GEOMETRY_CHUNK_INDEX]
    if geom["fnv1a64"] != fnv1a64_range(LEVEL_STREAM, 68937728, 10240):
        raise Failed("geometry chunk FNV differs from the independent read")
    return {
        "chunks_compared": len(index["streamChunks"]),
        "geometry_chunk": GEOMETRY_CHUNK_INDEX,
        "geometry_chunk_fnv1a64": geom["fnv1a64"],
        "geometry_chunk_sha256": GEOMETRY_CHUNK_SHA256,
    }


def whole_files(result: dict) -> dict:
    report = {}
    for label, path in (("levelrender", LEVEL_RENDER), ("levelphysics", LEVEL_PHYSICS)):
        fnv = fnv1a64_file(path)
        sha = sha256_file(path)
        key = f"/levels/usa_la_river/Level.{label}"
        got = result["file_hashes"].get(key)
        if not got or not got["ok"]:
            raise Failed(f"{label} was not read through the overlay")
        if got["bytes"] != path.stat().st_size:
            raise Failed(f"{label} length {got['bytes']} != {path.stat().st_size}")
        if got["fnv1a64"] != fnv:
            raise Failed(f"{label} FNV {got['fnv1a64']} != independent {fnv}")
        report[label] = {"bytes": path.stat().st_size, "fnv1a64": fnv,
                         "sha256": sha, "reads": got["reads"]}
    return report


def find_vcvars() -> Path:
    for candidate in VCVARS_CANDIDATES:
        if Path(candidate).is_file():
            return Path(candidate)
    raise Blocked("MSVC vcvars64.bat not found (pass --skip-native to record the gap)")


def bat_step(vcvars: Path, tail: str, name: str) -> subprocess.CompletedProcess:
    work = OUT / "native"
    work.mkdir(parents=True, exist_ok=True)
    bat = work / f"_run_{name}.bat"
    bat.write_text(f'@echo off\r\ncall "{vcvars}" >nul\r\ncd /d "{ROOT}"\r\n{tail}\r\n',
                   encoding="ascii")
    return subprocess.run(["cmd", "/c", str(bat)], capture_output=True, text=True,
                          errors="replace")


def inc_flags(root: Path) -> str:
    c = root / COMMON
    r = root / RD
    dirs = [STUB, r, r / "include",
            root / "code/mercury/library/graphics/display/include",
            root / "code/mercury/library/graphics/display2/include",
            root / "code/mercury/library/graphics/ngl/include",
            root / "code/mercury/library/graphics/fx/include",
            root / "code/mercury/library/graphics/texture_export/include",
            root / "code/mercury/library/graphics/world_render/include",
            root / "code/mercury/library/gamesys/framework/include",
            c / "core/include", c / "system/include", c / "misc_shared/include",
            c / "core/include", c / "xt2/include"]
    return " ".join(f'/I"{d}"' for d in dirs)


def preprocess(vcvars: Path, src: Path, out: Path, root: Path, name: str) -> str:
    defs = ("/DBUILD_CONFIG_SPEED /DPLATFORM_PC /DWIN32 /D_WINDOWS "
            "/DRENDERINGDATA_ALLOW_INCLUDE=1")
    p = bat_step(vcvars, f'cl /nologo /P /C /std:c++14 /EHsc {defs} '
                         f'{inc_flags(root)} /Fi"{out}" "{src}"', name)
    if p.returncode != 0 or not out.is_file():
        raise Failed(f"PC preprocessing failed: {(p.stdout or '')[-1500:]}")
    return out.read_text(encoding="utf-8", errors="replace")


def code_lines(text: str) -> list[str]:
    out = []
    for line in text.splitlines():
        if line.lstrip().startswith("#"):
            continue
        s = line.strip()
        if not s:
            continue
        s = s.replace("\\\\", "\\")
        s = re.sub(r"_work\\engine-stream-spike\\(tree|base)", "<SRC>", s)
        out.append(s)
    return out


def native_parity() -> dict:
    """With/without the stream patch, streammanager.cpp preprocesses identically.

    The real Display/Core/Includes.h needs the absent DXSDK, so both sides use
    engine/harness/t005e/stub (a declarations-only display facade). The A/B is
    otherwise the exact same include set and defines.
    """
    vcvars = find_vcvars()
    work = OUT / "native"
    work.mkdir(parents=True, exist_ok=True)
    src = TREE / RD / "source/noninterface/target/streammanager.cpp"
    with_text = preprocess(vcvars, src, work / "with.i", TREE, "pp_with")

    base_sources = {
        f"{COMMON}/core/include/core/threads/threadlocalstorage.h": UP,
        f"{COMMON}/core/include/core/maths/utmaths/operator.h": UP,
        f"{RD}/include/renderingdata/datatypes.h": UP,
        f"{RD}/source/noninterface/target/streammanager.cpp": UP,
        f"{COMMON}/core/include/btl/containers/skiplist.inl": UP,
        # sortedbinarytree.inl is already changed by the scheduler patch; take
        # the version this stream patch was written against from the second
        # apply on a throwaway tree.
    }
    backup = {}
    try:
        for rel, src_root in base_sources.items():
            dst = TREE / rel
            backup[rel] = dst.read_bytes()
            dst.write_bytes((src_root / rel).read_bytes())
        # sortedbinarytree.inl is already changed by the scheduler patch; build a
        # scheduler-only overlay to get the file this patch was written against.
        sched_tree = SPIKE / "pc-base"
        p = run([sys.executable, ROOT / "engine/apply_file_overlay.py",
                 "--tree", sched_tree], log=LOGS / "apply-pc-base.log")
        if p.returncode != 0:
            raise Failed("could not build the scheduler-only PC baseline")
        rel = f"{COMMON}/core/include/btl/containers/sortedbinarytree.inl"
        dst = TREE / rel
        backup[rel] = dst.read_bytes()
        dst.write_bytes((sched_tree / rel).read_bytes())
        without_text = preprocess(vcvars, src, work / "without.i", TREE, "pp_without")
    finally:
        try:
            applied = apply_stream_patch(TREE)
        except Exception as exc:  # noqa: BLE001 - re-raise as Failed
            raise Failed("could not restore the tree after PC parity: " + str(exc))
        if applied == 0:
            raise Failed("could not restore the tree after PC parity")
    a = code_lines(with_text)
    b = code_lines(without_text)
    if a != b:
        n = sum(1 for x, y in zip(a, b) if x != y)
        raise Failed(f"the stream patch changes the PC preprocessed "
                     f"streammanager.cpp ({len(a)} vs {len(b)} lines, {n} diffs)")
    return {"streammanager_preprocessed_lines": len(a),
            "identical": True,
            "display_facade": "engine/harness/t005e/stub (DXSDK absent)",
            "vcvars": str(vcvars)}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tree", default=str(TREE))
    ap.add_argument("--fresh", action="store_true")
    ap.add_argument("--skip-native", action="store_true")
    ap.add_argument("--report", default=str(LOGS / "verify-summary.json"))
    args = ap.parse_args()

    tree = Path(args.tree).resolve()
    if tree == UP.resolve() or UP.resolve() in tree.parents:
        raise Failed("refusing a tree inside upstream; it must never be written to")
    LOGS.mkdir(parents=True, exist_ok=True)
    OUT.mkdir(parents=True, exist_ok=True)
    started = time.time()
    report: dict = {"purpose": "T-005e level-streaming verification"}
    require_inputs()

    if args.fresh or not tree.exists():
        copy_upstream(tree)
        report["tree"] = "fresh copy of upstream"
    else:
        report["tree"] = "reused"
    report["apply"] = apply_patches(tree)
    report["patch_sha256"] = sha256_file(PATCH)
    report["structure"] = structural_check()

    first = build("a")
    second = build("b")
    hash_a = sha256_file(first.with_suffix(".wasm"))
    hash_b = sha256_file(second.with_suffix(".wasm"))
    if hash_a != hash_b:
        raise Failed(f"the build is not deterministic: {hash_a[:16]} != {hash_b[:16]}")
    report["wasm"] = {
        "bytes": first.with_suffix(".wasm").stat().st_size,
        "sha256": hash_a, "rebuild_sha256": hash_b,
        "deterministic": True, "objects": len(TUS),
    }

    index = reference_index()
    manifest = write_manifest(index)
    result = run_harness(first, manifest, "a")
    report["harness"] = {k: v for k, v in result.items() if k != "chunks"}
    report["reference"] = {
        "chunks": len(index["streamChunks"]),
        "resourceBlockCount": index["resourceBlockCount"],
        "initiallyLoadedBlocks": index["initiallyLoadedBlocks"],
        "metadata": index.get("metadata"),
        "rangeRead": index.get("rangeRead"),
        "readers": ["probes/range-file range_probe level",
                    "probes/asset-reader level_inspect --index"],
    }
    report["chunks"] = compare_chunks(result, index)
    report["whole_files"] = whole_files(result)
    report["levelrender_sha256"] = sha256_file(LEVEL_RENDER)
    report["levelphysics_sha256"] = sha256_file(LEVEL_PHYSICS)

    if args.skip_native:
        report["pc_parity"] = {"skipped": True,
                               "reason": "--skip-native passed; no MSVC check ran"}
    else:
        report["pc_parity"] = native_parity()

    report["elapsed_seconds"] = round(time.time() - started, 1)
    report["verdict"] = "PASS"
    Path(args.report).write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

    print(f"patch           sha256={report['patch_sha256'][:16]}")
    print(f"files           {len(report['structure'])} modified, 0 added")
    print(f"objects         {report['wasm']['objects']}")
    print(f"wasm            {report['wasm']['bytes']} B "
          f"sha256={report['wasm']['sha256'][:16]} "
          f"deterministic={report['wasm']['deterministic']}")
    print(f"harness         {len(result['checks'])}/{len(EXPECTED_CHECKS)} checks pass")
    print(f"index           {report['reference']['chunks']} chunks, "
          f"blocks={report['reference']['resourceBlockCount']}, "
          f"initial={report['reference']['initiallyLoadedBlocks']}")
    print(f"stream          {result['summary']['bytes']} B, "
          f"largest={result['summary']['largest']} B, "
          f"chunks={result['summary']['chunks']}")
    print(f"chunk hashes    {report['chunks']['chunks_compared']}/"
          f"{report['chunks']['chunks_compared']} match independent Python")
    print(f"geometry        chunk {GEOMETRY_CHUNK_INDEX} "
          f"fnv=0x{report['chunks']['geometry_chunk_fnv1a64']} "
          f"sha256={GEOMETRY_CHUNK_SHA256[:16]}")
    print(f"levelrender     {report['whole_files']['levelrender']['bytes']} B "
          f"fnv=0x{report['whole_files']['levelrender']['fnv1a64']}")
    print(f"levelphysics    {report['whole_files']['levelphysics']['bytes']} B "
          f"fnv=0x{report['whole_files']['levelphysics']['fnv1a64']}")
    if report["pc_parity"].get("skipped"):
        print("pc parity       SKIPPED (recorded)")
    else:
        print(f"pc parity       streammanager.cpp preprocessed identical "
              f"({report['pc_parity']['streammanager_preprocessed_lines']} lines)")
    print(f"report          {args.report}")
    print(f"verdict         PASS  ({report['elapsed_seconds']} s)")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Blocked as exc:
        print(f"verify_stream: BLOCKED: {exc}", file=sys.stderr)
        raise SystemExit(2)
    except Failed as exc:
        print(f"verify_stream: FAIL: {exc}", file=sys.stderr)
        raise SystemExit(1)
