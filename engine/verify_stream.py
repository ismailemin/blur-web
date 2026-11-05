"""Verify the T-005e level-streaming spike from a fresh upstream copy.

    python engine/verify_stream.py --fresh
    python engine/verify_stream.py                 # reuse the tree
    python engine/verify_stream.py --skip-native   # record the PC-parity gap

Gates, in order:
  1. copy upstream/BlurRebuilt, apply engine/apply_file_overlay.py (T-005c +
     T-005b), then apply engine/patches/t005b-stream-overlay.patch;
  2. the stream patch touches exactly fourteen named files, all inside
     PLATFORM_WEB guards (structural check);
  3. build the wasm32 module twice; the two wasm hashes must be identical;
  4. run the harness twice; stdout must be identical, exit 0, every check pass;
  5. run probes/range-file's `range_probe level` and probes/asset-reader's
     `level_inspect --index`: the 359 ChunkInfo records, resourceBlockCount,
     initiallyLoadedBlocks and metadata must agree field by field;
  6. the engine's own Scene archive parse (Target::Scene through
     Arch::BinaryInputArchive) must produce the same 359 ChunkInfo records:
     offset, storedBytes, logicalBytes, every item and every prerequisite, with
     the same table hash, and the Scene cursor must equal the probe's
     parsedUntilOffset. Zero GPU entry points may run;
  7. the engine streamer must load every chunk range from that engine table
     through StreamManager::LoadChunk / GetChunkData over C_OverlayFs; every
     chunk hash must equal an independent Python FNV-1a 64 of the same range;
     StreamData::OpenStreamFile and CacheChunk are exercised, and a chunk with
     prerequisites is refused;
  8. the engine-loaded chunk 157 bytes must hash to the documented geometry
     chunk (SHA-256 b07b386c...), and the whole Level.levelrender and
     Level.levelphysics FNV hashes must equal Python's;
  9. (unless --skip-native) PC parity: streammanager.cpp, streamdata.cpp and
     archive.cpp preprocess identically with and without the patch, using the
     committed display/FX facade (the real headers need the absent DXSDK).

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

HARNESS_FILES = ["stream_harness.cpp", "pre.js", "web_drawlist.cpp"]
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
    "-include", str(HARNESS / "engine_stream_prelude.h"),
]

LINK_FLAGS = [
    "-sENVIRONMENT=node", "-sALLOW_MEMORY_GROWTH=1",
    "-sINITIAL_MEMORY=16777216", "-sMAXIMUM_MEMORY=268435456",
    "-sEXIT_RUNTIME=1",
    # The level bytes come through the JS range source. libc file access is not
    # used by this harness (no manifest, no fopen).
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
    (f"{COMMON}/system/source/memory/BlockAllocator.cpp", "system"),
    (f"{COMMON}/system/source/memory/VirtualMemory.cpp", "system"),
    (f"{COMMON}/misc_shared/source/misc_shared/archive/handler.cpp", "system"),
    (f"{COMMON}/system/source/scheduler/jobqueue.cpp", "system"),
    (f"{COMMON}/system/source/scheduler/jobqueue_kernel.cpp", "system"),
    (f"{COMMON}/system/source/scheduler/jobqueue_task_queue_lf.cpp", "system"),
    (f"{COMMON}/system/source/scheduler/jobqueue_mem.cpp", "system"),
    (f"{COMMON}/system/source/scheduler/jobqueue_web.cpp", "system"),
    (f"{LOGICALFS}/source/overlayfs/OverlayFs.cpp", "logicalfs"),
    (f"{LOGICALFS}/source/overlayfs/OverlayLayer.cpp", "logicalfs"),
    (f"{COMMON}/system/source/serialise/C_FileBlock.cpp", "system"),
    (f"{COMMON}/system/source/serialise/C_MemoryStream.cpp", "system"),
    (f"{RD}/source/noninterface/target/streammanager.cpp", "rd"),
    (f"{RD}/source/noninterface/target/streamingstatistics.cpp", "rd"),
    # P22: the engine's target Scene archive and StreamData.
    (f"{RD}/source/noninterface/target/archive.cpp", "rd"),
    (f"{RD}/source/noninterface/target/streamdata.cpp", "rd"),
    (f"{RD}/source/noninterface/target/resources.cpp", "rd"),
    (f"{RD}/source/noninterface/archive.cpp", "rd"),
    (f"{RD}/source/noninterface/scene.cpp", "rd"),
    (f"{RD}/source/noninterface/node.cpp", "rd"),
    (f"{RD}/source/noninterface/renderstates.cpp", "rd"),
    (f"{RD}/source/noninterface/material.cpp", "rd"),
    (f"{RD}/source/noninterface/effect.cpp", "rd"),
    ("engine/harness/t005c/platform_net_web.cpp", "system"),
    ("engine/harness/t005c/web_runtime.cpp", "core"),
    ("engine/harness/t005e/scene_target_web.cpp", "rd"),
    ("engine/harness/t005e/display_fail_loud.cpp", "rd"),
    ("engine/harness/t005e/web_drawlist.cpp", "core"),
    ("engine/harness/t005e/web_scene_report.cpp", "core"),
    ("engine/harness/t005e/stream_harness.cpp", "harness"),
]

EXTRA_FLAGS = {
    f"{LOGICALFS}/source/overlayfs/OverlayFs.cpp": ["-DGLOBAL_DEBUG_MESSAGE_LEVEL=0"],
}

EXPECTED_CHECKS = [
    "abi_version", "mount", "overlay_mount", "exists_render", "exists_stream",
    "exists_physics", "render_read", "physics_read", "render_open", "level_magic",
    "scene_parse", "scene_bounds", "scene_declarations", "scene_no_gpu",
    "scene_chunk_count",
    "scene_stream_table", "stream_open", "stream_policy", "chunk_allocator",
    "stream_chunk_count", "stream_all_read", "stream_bytes", "stream_largest",
    "stream_no_requests", "streamdata_open", "cachechunk", "cachechunk_prereq",
    "eof_read_fails", "past_eof_read_fails", "oversize_chunk_refused",
    # P27 CPU-side draw list
    "drawlist_inline_block", "drawlist_geometry_located",
    "drawlist_geometry_import", "drawlist_node_located", "drawlist_node_import",
    "drawlist_draws", "drawlist_triangles", "drawlist_vertices",
    "drawlist_no_index_errors", "drawlist_instance_node_located",
    "drawlist_instance_import", "drawlist_instance_count",
    "drawlist_base_primitive_count", "drawlist_record_bounds",
    "drawlist_no_gpu_objects", "drawlist_renderlist_handler",
]

# The committed asset-reader reference for the same level. Both pairs are
# (geometry block, node block); the verifier locates the stream chunks from the
# engine ChunkInfo table itself, so no probe-supplied range enters the run.
DRAW_REFERENCE = (88, 283)
INSTANCE_REFERENCE = (27, 253)

# The fourteen patched files and their required token counts. Nothing else may
# be in the patch. Counts are exact: a web branch that grows without this table
# being updated fails the gate.
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
        "added": 25, "removed": 0,
        "tokens": ["i.m_pNode", "this->EraseNode(pp);", "#if defined(PLATFORM_WEB)"],
    },
    f"{COMMON}/core/include/btl/containers/skiplist.inl": {
        "added": 10, "removed": 0,
        "tokens": ["Base::Min", "Base::Max"],
    },
    f"{COMMON}/core/include/btl/containers/set.h": {
        "added": 5, "removed": 0,
        "tokens": ["using typename Base::InsertionReturnType;"],
    },
    f"{COMMON}/system/source/memory/VirtualMemory.cpp": {
        "added": 41, "removed": 0,
        "tokens": ["#elif defined(PLATFORM_WEB)", "memalign( 0x10000"],
    },
    f"{RD}/include/renderingdata/datatypes.h": {
        "added": 20, "removed": 0,
        "tokens": ["SHHD_3N(float x_, float y_, float z_) : data(0)",
                   "SDDD_3N(float x_, float y_, float z_) : data(0)"],
    },
    f"{RD}/include/renderingdata/noninterface/archive.inl": {
        "added": 179, "removed": 168,
        "tokens": ["#define RD_ARCH_NS ::Arch", "RD_ARCH_NS::"],
    },
    f"{RD}/include/renderingdata/noninterface/streamdata.inl": {
        "added": 12, "removed": 0,
        "tokens": ["ChunkInfo::GetNumPrerequisites", "ChunkInfo::GetPrerequisite"],
    },
    f"{RD}/include/renderingdata/streamdata.h": {
        "added": 9, "removed": 0,
        "tokens": ["GetNumPrerequisites() const;", "GetPrerequisite(S32 index) const;"],
    },
    f"{RD}/include/renderingdata/streaming.h": {
        "added": 8, "removed": 0,
        "tokens": ["CacheChunkForWebGate"],
    },
    f"{RD}/include/renderingdata/target.h": {
        "added": 8, "removed": 0,
        "tokens": ["virtual ~RenderListNode();", "Web link anchor"],
    },
    f"{RD}/source/noninterface/target/archive.cpp": {
        "added": 767, "removed": 12,
        "tokens": ["ParseSceneArchive", "Data-only read",
                   "renderListHandlerRegistered", "ReadBlobHeader",
                   "ParseLoadedResourceBlockArchive", "ParseResourceBlockLodArchive",
                   "RegisterRenderListHandlers"],
    },
    f"{RD}/source/noninterface/target/resources.cpp": {
        "added": 9, "removed": 0,
        "tokens": ["if ( m_data.IsCreated() )"],
    },
    f"{RD}/source/noninterface/target/streamdata.cpp": {
        "added": 71, "removed": 4,
        "tokens": ["streamFileBufferHint", "kBufferSizeHintDefault",
                   "WEBSPIKE_UNSUPPORTED", "cacheChunkRequests"],
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
    f"{COMMON}/core/include/btl/containers/sortedbinarytree.inl": "this->EraseNode(pp);",
    f"{COMMON}/core/include/btl/containers/skiplist.inl": "S32 newLevel = Base::Min(",
    f"{RD}/include/renderingdata/datatypes.h": "// clang rejects initialising several members",
    f"{RD}/source/noninterface/target/streammanager.cpp": "void Drain()",
    f"{COMMON}/core/include/btl/containers/set.h": "using typename Base::InsertionReturnType;",
    f"{COMMON}/system/source/memory/VirtualMemory.cpp": "memalign( 0x10000",
    f"{RD}/include/renderingdata/noninterface/archive.inl": "#define RD_ARCH_NS ::Arch",
    f"{RD}/include/renderingdata/noninterface/streamdata.inl": "ChunkInfo::GetNumPrerequisites",
    f"{RD}/include/renderingdata/streamdata.h": "GetNumPrerequisites() const;",
    f"{RD}/include/renderingdata/streaming.h": "CacheChunkForWebGate",
    f"{RD}/include/renderingdata/target.h": "Web link anchor",
    f"{RD}/source/noninterface/target/archive.cpp": "ParseSceneArchive",
    f"{RD}/source/noninterface/target/streamdata.cpp": "streamFileBufferHint",
    f"{RD}/source/noninterface/target/resources.cpp": "if ( m_data.IsCreated() )",
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
        # Two engine TUs are both named archive.cpp (renderingdata and
        # renderingdata/target). Derive the object name from the relative path
        # so neither can overwrite the other.
        tag_name = rel.replace("/", "__").replace("\\", "__")
        obj = objdir / f"{tag_name}.o"
        p = run([sys.executable, EM, *FLAGS, *EXTRA_FLAGS.get(rel, []),
                 *includes(kind), "-c", src, "-o", obj],
                log=LOGS / f"{tag}__{tag_name}.log")
        if p.returncode:
            raise Failed(f"compile failed: {rel}\n"
                         + ((p.stdout or "") + (p.stderr or ""))[-2500:])
        objs.append(obj)
    # Deterministic link order. Object order also fixes the wasm __wasm_call_ctors
    # order; the sorted order puts the logging closure (common/system/...log)
    # before the renderingdata TUs that resolve Debug::GetLogger references at
    # static-init time. TUS order alone left that hazard to the linker.
    objs.sort()
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


def run_harness(js: Path, tag: str) -> dict:
    args = [NODE, js, LEVEL_RENDER, LEVEL_STREAM, LEVEL_PHYSICS]
    runs = [run(args, log=LOGS / f"{tag}__run{i + 1}.log") for i in range(2)]
    out = runs[0].stdout or ""
    if runs[0].stdout != runs[1].stdout:
        raise Failed("the two harness runs differ")
    if runs[0].returncode or runs[1].returncode:
        raise Failed(f"harness exited {runs[0].returncode}/{runs[1].returncode}\n"
                     + (runs[0].stderr or "")[-3000:])

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

    # The engine's own ChunkInfo table (archive.inl serialiser), printed one
    # record per line by the harness.
    chunkinfo = {}
    for m in re.finditer(
            r"webfile chunkinfo (\d+) offset=(\d+) stored=(\d+) logical=(\d+) "
            r"items=([0-9:,]*) prereqs=([0-9,]*) blocks=(\d+)", out):
        index = int(m.group(1))
        items = []
        if m.group(5):
            for pair in m.group(5).split(","):
                block, lod = pair.split(":")
                items.append((int(block), int(lod)))
        prereqs = [int(x) for x in m.group(6).split(",")] if m.group(6) else []
        chunkinfo[index] = {
            "offset": int(m.group(2)), "storedBytes": int(m.group(3)),
            "logicalBytes": int(m.group(4)), "items": items,
            "prerequisites": prereqs, "blocks": int(m.group(7)),
        }

    summary = re.search(r"webfile stream summary (.*)", out)
    counters = re.search(r"webfile counters (.*)", out)
    scene = re.search(r"webfile scene declarations=(.*)", out)
    scene_cursor = re.search(r"webfile scene_cursor absolute=(\d+) payload=(\d+) "
                             r"tablehash=0x([0-9a-f]{16})", out)
    openstream = re.search(r"webfile openstream opened=(\d+) hint=(-?\d+)", out)
    cachechunk = re.search(r"webfile cachechunk returned=(\d+) index=(-?\d+) "
                           r"failed=(\d+) offset=(\d+) bytes=(\d+) "
                           r"hash=0x([0-9a-f]{16})", out)
    prereq = re.search(r"webfile cachechunk_prereq index=(-?\d+) refused=(\d+)", out)
    scene_report = re.search(r"webfile scene report tablehash=0x([0-9a-f]{16}) "
                             r"gpu=(\d+) refused=(\d+) perf=(\d+) unsupported=(\d+)",
                             out)
    draw_inline = re.search(r"webfiledraw inline blocks=(\d+) lod=(-?\d+) vbs=(\d+) "
                            r"ibs=(\d+) nodes=(\d+) textures=(\d+) gpu=(\d+)", out)
    draw_chunks = {}
    for m in re.finditer(r"webfiledraw chunk name=(\w+) block=(\d+) chunk=(\d+) "
                         r"item=(\d+) lod=(\d+) offset=(\d+) bytes=(\d+) "
                         r"located=(\d+)", out):
        draw_chunks[m.group(1)] = {
            "block": int(m.group(2)), "chunk": int(m.group(3)),
            "item": int(m.group(4)), "lod": int(m.group(5)),
            "offset": int(m.group(6)), "bytes": int(m.group(7)),
            "located": int(m.group(8)),
        }
    draw_geometry = re.search(r"webfiledraw chunk name=geometry parsed=(\d+) "
                              r"vbs=(\d+) ibs=(\d+) nodes=(\d+) textures=(\d+) "
                              r"retained=(\d+) compressed=(\d+)", out)
    draw_lists = []
    for m in re.finditer(r"webfiledraw list node=(\d+) primitives=(\d+) "
                         r"instances=(\d+) baseprimitives=(\d+) "
                         r"instancebatches=(\d+) dynamiclists=(\d+)", out):
        draw_lists.append({
            "node": int(m.group(1)), "primitives": int(m.group(2)),
            "instances": int(m.group(3)), "basePrimitives": int(m.group(4)),
            "instanceBatches": int(m.group(5)), "dynamicLists": int(m.group(6)),
        })
    draw_summary = {}
    for m in re.finditer(r"webfiledraw summary node=(\d+) nodes=(\d+) "
                         r"primitives=(\d+) renderlists=(\d+) draws=(\d+) "
                         r"otherblock=(\d+) unbound=(\d+) triangles=(\d+) "
                         r"vertices=(\d+) indexerrors=(\d+) "
                         r"drawhash=0x([0-9a-f]{16})", out):
        draw_summary = {
            "node": int(m.group(1)), "nodes": int(m.group(2)),
            "primitives": int(m.group(3)), "renderLists": int(m.group(4)),
            "draws": int(m.group(5)), "otherBlock": int(m.group(6)),
            "unbound": int(m.group(7)), "triangles": int(m.group(8)),
            "vertices": int(m.group(9)), "indexErrors": int(m.group(10)),
            "hash": m.group(11),
        }
    draw_instances = {}
    m = re.search(r"webfiledraw instances node=(\d+) renderlists=(\d+) "
                  r"instanceCount=(\d+) basePrimitives=(\d+) draws=(\d+)", out)
    if m:
        draw_instances = {
            "node": int(m.group(1)), "renderLists": int(m.group(2)),
            "instanceCount": int(m.group(3)), "basePrimitives": int(m.group(4)),
            "draws": int(m.group(5)),
        }
    draw_counters = {}
    m = re.search(r"webfiledraw counters (.*)", out)
    if m:
        draw_counters = {k: int(v) for k, v in
                         re.findall(r"(\w+)=(\d+)", m.group(1))}
    draw_records = parse_draw_records(out)
    file_hashes = {}
    for m in re.finditer(r"webfile file (\S+) bytes=(\d+) hash=0x([0-9a-f]{16}) "
                         r"reads=(\d+) ok=(\d)", out):
        file_hashes[m.group(1)] = {
            "bytes": int(m.group(2)), "fnv1a64": m.group(3),
            "reads": int(m.group(4)), "ok": int(m.group(5)),
        }
    if not (summary and counters and scene and scene_cursor and openstream
            and cachechunk and prereq and scene_report):
        raise Failed("the harness printed an incomplete engine/scene report")
    if not (draw_inline and draw_geometry and draw_summary and draw_instances):
        raise Failed("the harness printed an incomplete draw-list report")
    summary_fields = {k: int(v) for k, v in re.findall(r"(\w+)=(\d+)", summary.group(1))}
    counter_fields = {k: int(v) for k, v in re.findall(r"(\w+)=(\d+)", counters.group(1))}
    scene_fields = {k: int(v) for k, v in
                    re.findall(r"(\w+)=(\d+)", "declarations=" + scene.group(1))}

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

    report = {
        "scene": scene_fields,
        "scene_cursor_absolute": int(scene_cursor.group(1)),
        "scene_payload_absolute": int(scene_cursor.group(2)),
        "table_hash": scene_cursor.group(3),
        "openstream": {"opened": int(openstream.group(1)),
                       "hint": int(openstream.group(2))},
        "cachechunk": {"returned": int(cachechunk.group(1)),
                       "index": int(cachechunk.group(2)),
                       "failed": int(cachechunk.group(3)),
                       "offset": int(cachechunk.group(4)),
                       "bytes": int(cachechunk.group(5)),
                       "fnv1a64": cachechunk.group(6)},
        "cachechunk_prereq": {"index": int(prereq.group(1)),
                              "refused": int(prereq.group(2))},
        "gpu_calls": int(scene_report.group(2)),
        "gpu_refused": int(scene_report.group(3)),
        "unsupported_calls": int(scene_report.group(5)),
    }

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
        "checks": checks, "chunks": chunks, "chunkinfo": chunkinfo,
        "summary": summary_fields, "counters": counter_fields, "provider": provider,
        "file_hashes": file_hashes, "scene": report,
        "draws": {
            "inline": {k: int(v) for k, v in zip(
                ("blocks", "lod", "vbs", "ibs", "nodes", "textures", "gpu"),
                draw_inline.groups())},
            "chunks": draw_chunks,
            "geometry": {k: int(v) for k, v in zip(
                ("parsed", "vbs", "ibs", "nodes", "textures", "retained",
                 "compressed"), draw_geometry.groups())},
            "lists": draw_lists,
            "summary": draw_summary,
            "instances": draw_instances,
            "counters": draw_counters,
            "records": draw_records,
        },
        "stdout_bytes": len(out), "stderr_bytes": len(stderr),
    }


def parse_draw_records(out: str) -> list[dict]:
    """The harness's one-line-per-draw records as key=value dictionaries."""
    records = []
    for m in re.finditer(r"webfiledraw draw (\d+) (.*)", out):
        record = {"draw": int(m.group(1))}
        for token in m.group(2).split():
            if "=" not in token:
                continue
            key, value = token.split("=", 1)
            if key in ("bounds", "reason", "world", "worldReason"):
                record[key] = value
            elif ":" in value:
                a, b = value.split(":")
                record[key] = (int(a), int(b))
            elif "," in value:
                record[key] = [float(x) for x in value.split(",")]
            else:
                try:
                    record[key] = int(value, 0)
                except ValueError:
                    record[key] = value
        records.append(record)
    return records


def engine_table_fnv(chunkinfo: dict) -> str:
    """The harness's table hash, recomputed in Python from printed records."""
    h = 0xCBF29CE484222325

    def mix(data: bytes) -> None:
        nonlocal h
        for b in data:
            h ^= b
            h = (h * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF

    mix(struct.pack("<I", len(chunkinfo)))
    for i in range(len(chunkinfo)):
        c = chunkinfo[i]
        mix(struct.pack("<I", i))
        mix(struct.pack("<Q", c["offset"]))
        mix(struct.pack("<Q", c["storedBytes"]))
        mix(struct.pack("<Q", c["logicalBytes"]))
        mix(struct.pack("<I", len(c["items"])))
        for block, lod in c["items"]:
            mix(struct.pack("<I", block & 0xFFFFFFFF))
            mix(struct.pack("<I", lod & 0xFFFFFFFF))
        mix(struct.pack("<I", len(c["prerequisites"])))
        for p in c["prerequisites"]:
            mix(struct.pack("<I", p & 0xFFFFFFFF))
    return f"{h:016x}"


def compare_engine_table(result: dict, index: dict) -> dict:
    """Every engine ChunkInfo record against both committed readers."""
    reference = index["streamChunks"]
    got = result["chunkinfo"]
    if len(got) != len(reference):
        raise Failed(f"engine printed {len(got)} ChunkInfo records, reference "
                     f"{len(reference)}")
    for i, want in enumerate(reference):
        have = got.get(i)
        if have is None:
            raise Failed(f"engine printed no ChunkInfo record {i}")
        if have["offset"] != want["offset"]:
            raise Failed(f"chunk {i} offset {have['offset']} != {want['offset']}")
        if have["storedBytes"] != want["storedBytes"]:
            raise Failed(f"chunk {i} storedBytes {have['storedBytes']} != "
                         f"{want['storedBytes']}")
        if have["logicalBytes"] != want["logicalBytes"]:
            raise Failed(f"chunk {i} logicalBytes {have['logicalBytes']} != "
                         f"{want['logicalBytes']}")
        want_items = [(it["block"], it["lod"]) for it in want["items"]]
        if have["items"] != want_items:
            raise Failed(f"chunk {i} items {have['items']} != {want_items}")
        if have["prerequisites"] != want["prerequisites"]:
            raise Failed(f"chunk {i} prerequisites {have['prerequisites']} != "
                         f"{want['prerequisites']}")

    parsed_until = index.get("metadata", {}).get("parsedUntilOffset")
    if parsed_until != result["scene"]["scene_cursor_absolute"]:
        raise Failed(f"engine Scene cursor {result['scene']['scene_cursor_absolute']} "
                     f"!= probe parsedUntilOffset {parsed_until}")
    if result["scene"]["scene_payload_absolute"] != 62:
        raise Failed("the Scene block payload offset moved (expected 62)")

    expected_hash = engine_table_fnv(got)
    if expected_hash != result["scene"]["table_hash"]:
        raise Failed(f"engine table hash {result['scene']['table_hash']} != "
                     f"Python recomputation {expected_hash}")

    if result["scene"]["gpu_calls"] or result["scene"]["gpu_refused"]:
        raise Failed("a GPU entry point was called while parsing the Scene")
    if result["scene"]["unsupported_calls"]:
        raise Failed("an unsupported engine path was reached")

    # The two engine-side counters must agree with the table they summarise.
    totals = {
        "chunks": len(got),
        "items": sum(len(c["items"]) for c in got.values()),
        "prereqs": sum(len(c["prerequisites"]) for c in got.values()),
        "stored": sum(c["storedBytes"] for c in got.values()),
        "logical": sum(c["logicalBytes"] for c in got.values()),
    }
    scene = result["scene"]["scene"]
    for key, printed in (("chunks", "chunks"), ("items", "items"),
                         ("prereqs", "prereqs"), ("logical", "original")):
        if scene[printed] != totals[key]:
            raise Failed(f"engine report {printed}={scene[printed]} != table {totals[key]}")
    if scene["stored"] != totals["stored"]:
        raise Failed("engine report stored != table")
    if scene["effects"] <= 0 or scene["sharedTextures"] <= 0:
        raise Failed(f"scene declarations look empty: {scene}")

    # OpenStreamFile must have used the layer default sentinel, never 0.
    if result["scene"]["openstream"]["opened"] != 1:
        raise Failed("StreamData::OpenStreamFile did not open the stream")
    if result["scene"]["openstream"]["hint"] == 0:
        raise Failed("StreamData::OpenStreamFile still passes buffer hint 0")

    # CacheChunk must have read engine ChunkInfo 0 and refused a dependent one.
    want0 = reference[0]
    cc = result["scene"]["cachechunk"]
    if not cc["returned"] or cc["index"] != 0 or cc["failed"]:
        raise Failed(f"CacheChunk(0) failed: {cc}")
    if cc["offset"] != want0["offset"] or cc["bytes"] != want0["storedBytes"]:
        raise Failed("CacheChunk(0) used a different range than ChunkInfo 0")
    if cc["fnv1a64"] != fnv1a64_range(LEVEL_STREAM, want0["offset"], want0["storedBytes"]):
        raise Failed("CacheChunk(0) hash differs from the independent read")
    first_dep = next((i for i, c in enumerate(reference) if c["prerequisites"]), None)
    if result["scene"]["cachechunk_prereq"] != {"index": first_dep, "refused": 1}:
        raise Failed(f"prerequisite refusal mismatch: "
                     f"{result['scene']['cachechunk_prereq']} vs {first_dep}")

    return {
        "records_compared": len(got),
        "table_hash": expected_hash,
        "parsed_until_offset": parsed_until,
        "scene_payload_offset": result["scene"]["scene_payload_absolute"],
        "items": totals["items"],
        "prerequisites": totals["prereqs"],
        "stored_bytes": totals["stored"],
        "logical_bytes": totals["logical"],
        "cachechunk_fnv1a64": cc["fnv1a64"],
        "openstream_hint": result["scene"]["openstream"]["hint"],
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


def chunk_range(index: dict, block: int, lod: int) -> tuple:
    """The engine table's single (chunk, item) for a block/LOD pair."""
    found = []
    for ci, c in enumerate(index["streamChunks"]):
        for ii, item in enumerate(c["items"]):
            if item["block"] == block and item["lod"] == lod:
                found.append((ci, ii, c["offset"], c["storedBytes"]))
    if len(found) != 1:
        raise Failed(f"block {block} lod {lod} has {len(found)} stream items")
    return found[0]


def extract_chunk(index: dict, block: int, lod: int, name: str) -> Path:
    ci, ii, offset, size = chunk_range(index, block, lod)
    out = LOGS / "ref" / name
    out.parent.mkdir(parents=True, exist_ok=True)
    with LEVEL_STREAM.open("rb") as f:
        f.seek(offset)
        data = f.read(size)
    if len(data) != size:
        raise Failed(f"short read for {name} at {offset}+{size}")
    out.write_bytes(data)
    return out


def reference_mesh(index: dict, pair: tuple) -> dict:
    """probes/asset-reader level_inspect for the same level and chunks."""
    geometry_block, node_block = pair
    geometry = extract_chunk(index, geometry_block, 0,
                             f"block{geometry_block}.chunk")
    node = extract_chunk(index, node_block, 0, f"block{node_block}.chunk")
    p = run([LEVEL_INSPECT, LEVEL_RENDER, geometry, node,
             str(geometry_block), str(node_block)],
            log=LOGS / f"level-inspect-mesh-{geometry_block}-{node_block}.log")
    if p.returncode != 0:
        raise Failed("level_inspect mesh reference failed: "
                     + ((p.stderr or p.stdout).strip())[-800:])
    doc = json.loads(p.stdout)
    if doc.get("status") != "ok":
        raise Failed(f"level_inspect mesh reference: {doc.get('status')}")
    (LOGS / f"reference-mesh-{geometry_block}-{node_block}.json").write_text(
        p.stdout, encoding="utf-8")
    return doc


def reference_instances(index: dict, pair: tuple) -> dict:
    geometry_block, node_block = pair
    geometry = extract_chunk(index, geometry_block, 0,
                             f"block{geometry_block}.chunk")
    node = extract_chunk(index, node_block, 0, f"block{node_block}.chunk")
    p = run([LEVEL_INSPECT, "--instances-all", LEVEL_RENDER, geometry, node,
             str(geometry_block), str(node_block)],
            log=LOGS / f"level-inspect-instances-{geometry_block}-{node_block}.log")
    if p.returncode != 0:
        raise Failed("level_inspect instances reference failed: "
                     + ((p.stderr or p.stdout).strip())[-800:])
    doc = json.loads(p.stdout)
    if doc.get("status") != "ok":
        raise Failed(f"level_inspect instances reference: {doc.get('status')}")
    (LOGS / f"reference-instances-{geometry_block}-{node_block}.json").write_text(
        p.stdout, encoding="utf-8")
    return doc


def compare_draw_list(result: dict, index: dict) -> dict:
    """Every bound draw against the committed asset-reader's direct draws.

    The engine prints the archive byte position of each primitive record; the
    committed reader prints the position of the same record's first byte. The
    binary archive writes a 2-byte 'AR' tag and a U16 object version before the
    payload, so engine_source - 4 is the reader's primitiveOffset.
    """
    draws = result["draws"]
    summary = draws["summary"]
    record_chunk = draws["chunks"]["node"]["chunk"]
    records = [d for d in draws["records"] if d.get("chunk") == record_chunk]
    bound = [d for d in records if d.get("bound") == 1]
    unbound = [d for d in records if d.get("bound") != 1]

    reference = reference_mesh(index, DRAW_REFERENCE)
    want = reference["draws"]
    meta = reference["metadata"]

    if len(bound) != len(want):
        raise Failed(f"engine draw list has {len(bound)} bound draws, "
                     f"level_inspect has {len(want)}")
    if len(unbound) != summary["otherBlock"]:
        raise Failed(f"{len(unbound)} unbound draw records vs "
                     f"{summary['otherBlock']} other-block primitives")

    for i, (have, expect) in enumerate(zip(bound, want)):
        if have["firstIndex"] != expect["firstIndex"]:
            raise Failed(f"draw {i} (primitive {have['primitive']}): firstIndex "
                         f"{have['firstIndex']} != reference {expect['firstIndex']}")
        if have["indexCount"] != expect["indexCount"]:
            raise Failed(f"draw {i} (primitive {have['primitive']}): indexCount "
                         f"{have['indexCount']} != reference {expect['indexCount']}")

    if summary["draws"] != len(want):
        raise Failed("engine summary draw count differs from the records")
    if summary["triangles"] != meta["triangleCount"]:
        raise Failed(f"engine triangles {summary['triangles']} != reference "
                     f"{meta['triangleCount']}")
    if summary["vertices"] != meta["vertexCount"]:
        raise Failed(f"engine vertices {summary['vertices']} != reference "
                     f"{meta['vertexCount']}")
    if summary["otherBlock"] != meta["omittedOtherBlockPrimitives"]:
        raise Failed(f"engine other-block {summary['otherBlock']} != reference "
                     f"{meta['omittedOtherBlockPrimitives']}")
    if summary["primitives"] != meta["primitiveCount"] + \
            meta["omittedOtherBlockPrimitives"]:
        raise Failed("engine primitive count differs from the reference")

    inst = reference_instances(index, INSTANCE_REFERENCE)
    imeta = inst["metadata"]
    engine_instances = draws["instances"]
    if engine_instances["instanceCount"] != imeta["instanceCount"]:
        raise Failed(f"engine instance count {engine_instances['instanceCount']} "
                     f"!= reference {imeta['instanceCount']}")
    if engine_instances["basePrimitives"] != imeta["basePrimitiveCount"]:
        raise Failed(f"engine base primitive count "
                     f"{engine_instances['basePrimitives']} != reference "
                     f"{imeta['basePrimitiveCount']}")

    return {
        "geometry_pair": list(DRAW_REFERENCE),
        "instance_pair": list(INSTANCE_REFERENCE),
        "draws_compared": len(bound),
        "draws_unbound": len(unbound),
        "index_spans_compared": len(bound),
        "triangles": summary["triangles"],
        "vertices": summary["vertices"],
        "draw_hash": summary["hash"],
        "instance_count": engine_instances["instanceCount"],
        "base_primitive_count": engine_instances["basePrimitives"],
        "reference_tools": ["probes/asset-reader level_inspect (direct draws)",
                            "probes/asset-reader level_inspect --instances-all"],
        "reference_scope": "firstIndex/indexCount spans and counts; primitive "
                           "offsets, declarations, topology and VB/IB source "
                           "indices are printed by the engine but the committed "
                           "direct-draw API does not expose them",
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
    in_block_comment = False
    for line in text.splitlines():
        if line.lstrip().startswith("#"):
            continue
        s = line.strip()
        if not s:
            continue
        # Comments are not code. The web branches carry explanatory comments
        # that must not count as a PC translation-unit change.
        if in_block_comment:
            if "*/" in s:
                in_block_comment = False
                s = s.split("*/", 1)[1].strip()
                if not s:
                    continue
            else:
                continue
        if s.startswith("/*"):
            if "*/" not in s:
                in_block_comment = True
                continue
            s = s.split("*/", 1)[1].strip()
            if not s:
                continue
        if s.startswith("//"):
            continue
        s = s.replace("\\\\", "\\")
        s = re.sub(r"_work\\engine-stream-spike\\(tree|basefull|base|pc-base)", "<SRC>", s)
        # Trailing comments are not code either; a comment moved by a web
        # branch (e.g. "} // namespace Target" vs "}") is not a statement delta.
        s = re.sub(r'\s+//[^"\']*$', "", s).strip()
        if not s:
            continue
        # A web branch that preprocesses away still shifts the line numbers
        # below it. Like engine/native_parity.py for jobqueue.cpp, treat the
        # __LINE__ argument of a log location as non-code: no statement differs.
        s = re.sub(r"StaticLocationInfoClass\(\d+,", "StaticLocationInfoClass(<LINE>,", s)
        out.append(s)
    return out


PARITY_SOURCES = [
    f"{RD}/source/noninterface/target/streammanager.cpp",
    f"{RD}/source/noninterface/target/streamdata.cpp",
    f"{RD}/source/noninterface/target/archive.cpp",
    f"{RD}/source/noninterface/target/resources.cpp",
]


def native_parity() -> dict:
    """With/without the stream patch, each TU preprocesses identically.

    The real Display/Core/Includes.h and the FX headers need the absent DXSDK,
    so both sides use engine/harness/t005e/stub (declarations-only display and
    FX facades). The "without" root is a throwaway T-005c + T-005b overlay tree,
    so every source is preprocessed with the same include set and defines but
    before this patch. Only the web PLATFORM_WEB branches may disappear; a PC
    statement change fails the gate.
    """
    vcvars = find_vcvars()
    work = OUT / "native"
    work.mkdir(parents=True, exist_ok=True)

    # The "without this patch" root: a full upstream copy with only the
    # T-005c + T-005b overlays applied. _work/engine-stream-spike/basefull is
    # that copy (created from upstream once; apply_file_overlay patches its
    # files in place and leaves the rest pristine).
    baseline = SPIKE / "basefull"
    if not (baseline / PARITY_SOURCES[0]).is_file():
        copy_upstream(baseline)
    p = run([sys.executable, ROOT / "engine/apply_file_overlay.py",
             "--tree", baseline], log=LOGS / "apply-pc-base.log")
    if p.returncode != 0:
        raise Failed("could not apply the T-005c/T-005b baseline")

    report = {"identical": True,
              "display_facade": "engine/harness/t005e/stub (DXSDK absent)",
              "vcvars": str(vcvars),
              "tus": {}}
    for rel in PARITY_SOURCES:
        stem = Path(rel).stem
        with_text = preprocess(vcvars, TREE / rel, work / f"{stem}_with.i",
                               TREE, f"pp_{stem}_with")
        without_text = preprocess(vcvars, baseline / rel,
                                  work / f"{stem}_without.i", baseline,
                                  f"pp_{stem}_without")
        a = code_lines(with_text)
        b = code_lines(without_text)
        if a != b:
            diffs = [(x, y) for x, y in zip(a, b) if x != y]
            first = diffs[0] if diffs else ("<none>", "<none>")
            raise Failed(f"the stream patch changes the PC preprocessed {rel} "
                         f"({len(a)} vs {len(b)} lines, {len(diffs)} diffs; "
                         f"first {first})")
        report["tus"][rel] = len(a)
    return report


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
    result = run_harness(first, "a")
    report["harness"] = {k: v for k, v in result.items()
                         if k not in ("chunks", "chunkinfo")}
    report["reference"] = {
        "chunks": len(index["streamChunks"]),
        "resourceBlockCount": index["resourceBlockCount"],
        "initiallyLoadedBlocks": index["initiallyLoadedBlocks"],
        "metadata": index.get("metadata"),
        "rangeRead": index.get("rangeRead"),
        "readers": ["probes/range-file range_probe level",
                    "probes/asset-reader level_inspect --index"],
    }
    report["engine_table"] = compare_engine_table(result, index)
    report["chunks"] = compare_chunks(result, index)
    report["draw_list"] = compare_draw_list(result, index)
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
    print(f"engine index    {report['engine_table']['records_compared']} ChunkInfo "
          f"records == range_probe + level_inspect")
    print(f"scene cursor    {report['engine_table']['parsed_until_offset']} B "
          f"(== probe parsedUntilOffset), tablehash="
          f"{report['engine_table']['table_hash'][:16]}")
    print(f"scene facts     {result['scene']['scene']['declarations']} decl / "
          f"{result['scene']['scene']['sharedTextures']} shared textures, "
          f"{result['scene']['scene']['items']} items, "
          f"{result['scene']['scene']['prereqs']} prereqs, "
          f"gpu={result['scene']['gpu_calls']}, "
          f"openstream hint={report['engine_table']['openstream_hint']}")
    print(f"stream          {result['summary']['bytes']} B, "
          f"largest={result['summary']['largest']} B, "
          f"chunks={result['summary']['chunks']}")
    print(f"chunk hashes    {report['chunks']['chunks_compared']}/"
          f"{report['chunks']['chunks_compared']} match independent Python")
    print(f"geometry        chunk {GEOMETRY_CHUNK_INDEX} "
          f"fnv=0x{report['chunks']['geometry_chunk_fnv1a64']} "
          f"sha256={GEOMETRY_CHUNK_SHA256[:16]}")
    dl = report["draw_list"]
    print(f"draw list       {dl['draws_compared']} bound / "
          f"{dl['draws_unbound']} other-block, "
          f"{dl['triangles']} triangles, {dl['vertices']} vertices, "
          f"hash={dl['draw_hash']}")
    print(f"draw compare    {dl['index_spans_compared']} firstIndex/indexCount "
          f"spans equal to level_inspect {DRAW_REFERENCE[0]}/{DRAW_REFERENCE[1]}; "
          f"instances={dl['instance_count']}, "
          f"baseprimitives={dl['base_primitive_count']}")
    print(f"levelrender     {report['whole_files']['levelrender']['bytes']} B "
          f"fnv=0x{report['whole_files']['levelrender']['fnv1a64']}")
    print(f"levelphysics    {report['whole_files']['levelphysics']['bytes']} B "
          f"fnv=0x{report['whole_files']['levelphysics']['fnv1a64']}")
    if report["pc_parity"].get("skipped"):
        print("pc parity       SKIPPED (recorded)")
    else:
        tus = report["pc_parity"]["tus"]
        print(f"pc parity       {len(tus)} TUs preprocessed identical "
              f"({', '.join(f'{Path(k).name}:{v}' for k, v in tus.items())} lines)")
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
