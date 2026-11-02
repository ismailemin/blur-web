"""Verify the T-005d gravity static-collision spike against the committed oracle.

    python engine/verify_gravity.py --fresh
    python engine/verify_gravity.py --skip-build

What it does, in order:
  1. copies upstream/BlurRebuilt to _work/engine-gravity-spike/tree (optional),
  2. applies the T-005c scheduler + T-005b file overlays with
     engine/apply_file_overlay.py,
  3. applies engine/patches/t005d-gravity-overlay.patch on top.  That patch is
     empty by measurement: the Gravity TUs this spike needs compile against the
     two existing overlays with no engine source change,
  4. compiles the Gravity static-collision TU set plus the logging/platform
     closure and the harness for wasm32, twice, and compares the .wasm hashes,
  5. runs the module twice on game-data/Blur/levels/usa_la_river/Level.levelphysics
     and compares the JSON byte for byte,
  6. compares every canonical record with probes/collision-oracle's native
     document, names the first divergence and the field, and compares
     queryHash with f87365b79fc1217da4280d6d5748ca6dc6808b89382b87de43ddcbfe6c9b5d6e,
  7. checks that the parsed mesh geometry matches the oracle's mesh counts.

The queryHash is EXPECTED to differ.  The engine's records carry six fields with
different semantics from the probe's re-expression (all measured, see
docs/work/analysis/engine-gravity-layer.md).  The verifier reports the exact
first divergence; it never claims equality.

Stdlib only.  Reads upstream and the level file; writes only under
_work/engine-gravity-spike/ and _work/logs/engine-gravity-spike/.
"""
from __future__ import annotations

import argparse
import hashlib
import json
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
SPIKE = ROOT / "_work/engine-gravity-spike"
TREE = SPIKE / "tree"
OUT = SPIKE / "out"
LOGS = ROOT / "_work/logs/engine-gravity-spike"
HARNESS = ROOT / "engine/harness/t005d"

EM = ROOT / "_work/toolchains/emsdk/upstream/emscripten/em++.py"
NODE = ROOT / "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"
COMMON = "code/mercury/library/common"
GRAVITY = "code/mercury/library/physics/gravity"
LEVEL = ROOT / "game-data/Blur/levels/usa_la_river/Level.levelphysics"
ORACLE = ROOT / "_work/collision-oracle/native.json"
PATCH = ROOT / "engine/patches/t005d-gravity-overlay.patch"
ORACLE_RUNNER = ROOT / "probes/collision-oracle/tests/run_collision_oracle.py"

EXPECTED_QUERY_HASH = "f87365b79fc1217da4280d6d5748ca6dc6808b89382b87de43ddcbfe6c9b5d6e"
EXPECTED_RECORD_BYTES = 7768
EXPECTED_MESHES = [
    {"numVertices": 44970, "numNormals": 25540, "numTriangles": 31860,
     "numLeaves": 4147, "numNodes": 8293, "numHeaders": 6420,
     "numActiveEdges": 4894, "triangleBufferBytes": 485040},
    {"numVertices": 17671, "numNormals": 1264, "numTriangles": 12384,
     "numLeaves": 1768, "numNodes": 3535, "numHeaders": 1780,
     "numActiveEdges": 3165, "triangleBufferBytes": 177088},
]

# The probe's formatVersion 1 records contain six fields that report engine
# values differently from what the probe chose to expose (materials split by
# body/triangle, patch normal vs per-contact normal, engine triangle stream
# value vs per-triangle ordinal, unassigned trace flags, stored vs normalised
# trace normal). These are the ONLY differences allowed; anything else is a
# regression and fails the gate.
EXPECTED_DIVERGENCE = {
    "rays": {"same": 24, "different": 0, "fields": {}},
    "spheres": {
        "same": 8, "different": 16,
        "fields": {
            "contact.effectMaterial": 118,
            "contact.normal.x": 56,
            "contact.normal.y": 62,
            "contact.normal.z": 57,
            "contact.physicsMaterial": 56,
        },
    },
    "cacheQueries": {
        "same": 1, "different": 7,
        "fields": {
            "entry.engineTriangleIndex": 13,
            "trace.collisionFlags": 20,
            "trace.engineTriangleIndex": 1,
            "trace.normal.x": 10,
            "trace.normal.y": 10,
            "trace.normal.z": 8,
        },
    },
}
EXPECTED_FIRST_DIVERGENCE = {
    "canonicalQueryIndex": 24,
    "kind": "spheres",
    "label": "point-vertex-0",
    "byteOffset": 48,
    "field": "contact[0].physicsMaterial",
}

FLAGS = [
    "-DBUILD_CONFIG_SPEED", "-DPLATFORM_WEB", "-std=c++14", "-O2",
    "-fno-fast-math", "-ffp-contract=off",
    "-fdelayed-template-parsing", "-D__restrict=", "-fdeclspec",
    "-Wno-nonportable-include-path", "-Wno-ignored-attributes",
    "-Wno-deprecated-register", "-Wno-return-type", "-Wno-c++20-extensions",
    "-include", str(ROOT / "engine/harness/t005b/msvc_crt_web.h"),
    "-include", str(ROOT / "engine/harness/t005c/web_platform.h"),
]

LINK_FLAGS = [
    "-O2", "-fno-fast-math", "-ffp-contract=off",
    "-sMODULARIZE=1", "-sEXPORT_ES6=1", "-sENVIRONMENT=node,web",
    "-sALLOW_MEMORY_GROWTH=1", "-sINITIAL_MEMORY=67108864",
    "-sMAXIMUM_MEMORY=536870912", "-sSTACK_SIZE=4194304", "--no-entry",
    "-sEXPORTED_FUNCTIONS=_gravity_run,_gravity_free,_gravity_selftest,_gravity_flags,_malloc,_free",
    "-sEXPORTED_RUNTIME_METHODS=UTF8ToString,HEAPU8",
]

# (path relative to the tree unless it starts with engine/, include kind)
TUS = [
    (f"{GRAVITY}/source/narrowphase/OptimisedAABBTree.cpp", "gravity"),
    (f"{GRAVITY}/source/narrowphase/LineCollisionCache.cpp", "gravity"),
    (f"{GRAVITY}/source/narrowphase/Shapes.cpp", "gravity"),
    (f"{GRAVITY}/source/narrowphase/PrimitiveClosestPointsTest.cpp", "gravity"),
    (f"{GRAVITY}/source/narrowphase/PrimitiveIntersectTest.cpp", "gravity"),
    (f"{GRAVITY}/source/narrowphase/AABB.cpp", "gravity"),
    (f"{GRAVITY}/source/sharedphysics/SPU_Memory.cpp", "gravity"),
    (f"{GRAVITY}/source/sharedphysics/GravityConstants.cpp", "gravity"),
    (f"{COMMON}/system/source/serialise/C_MemoryStream.cpp", "system"),
    (f"{COMMON}/core/source/allocators/CoreMemoryAligned.cpp", "core"),
    (f"{COMMON}/core/source/utility/BizAssert.cpp", "core"),
    (f"{COMMON}/core/source/utility/endian.cpp", "core"),
    (f"{COMMON}/core/source/maths/hvec/SIMD.cpp", "core"),
    (f"{COMMON}/core/source/maths/hvec/Constants.cpp", "core"),
    (f"{COMMON}/core/source/threads/Thread.cpp", "core"),
    (f"{COMMON}/core/source/threads/RwLock.cpp", "core"),
    (f"{COMMON}/core/source/threads/Mutex.cpp", "core"),
    (f"{COMMON}/core/source/threads/Event.cpp", "core"),
    (f"{COMMON}/system/source/time/Time.cpp", "system"),
    (f"{COMMON}/system/source/debug/Debug.cpp", "system"),
    (f"{COMMON}/system/source/debug/Variables.cpp", "system"),
    (f"{COMMON}/system/source/debug/log/LogManager.cpp", "system"),
    (f"{COMMON}/system/source/debug/log/Logger.cpp", "system"),
    (f"{COMMON}/system/source/debug/log/Format.cpp", "system"),
    (f"{COMMON}/system/source/debug/log/DebugLevel.cpp", "system"),
    (f"{COMMON}/system/source/debug/log/Filter.cpp", "system"),
    (f"{COMMON}/system/source/debug/log/ThreadContext.cpp", "system"),
    (f"{COMMON}/system/source/debug/log/subscribers/ConsoleSubscriber.cpp", "system"),
    (f"{COMMON}/system/source/debug/log/subscribers/SubscriberCommon.cpp", "system"),
    (f"{COMMON}/system/source/debug/log/subscribers/SubscriberManager.cpp", "system"),
    ("engine/harness/t005c/platform_net_web.cpp", "system"),
    ("engine/harness/t005c/web_runtime.cpp", "core"),
    ("engine/harness/t005d/gravity_harness.cpp", "harness"),
]


class Failed(RuntimeError):
    pass


class Blocked(RuntimeError):
    pass


def run(cmd, log=None):
    p = subprocess.run([str(c) for c in cmd], capture_output=True, text=True, errors="replace")
    if log is not None:
        text = "$ " + " ".join(str(c) for c in cmd) + "\n" + (p.stdout or "") + (p.stderr or "")
        log.parent.mkdir(parents=True, exist_ok=True)
        log.write_text(text, encoding="utf-8", errors="replace")
    return p


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def includes(kind: str) -> list[str]:
    common = TREE / COMMON
    dirs = [common / "core/include", common / "core",
            common / "system/include", common / "btl/include"]
    if kind in ("system", "gravity", "harness"):
        dirs += [common / "system", common / "system/source/scheduler",
                 common / "misc_shared", common / "misc_shared/include",
                 common / "xt2/include"]
    if kind in ("gravity", "harness"):
        dirs += [TREE / GRAVITY, TREE / GRAVITY / "include"]
    if kind == "harness":
        dirs.append(HARNESS)
    return [f"-I{d}" for d in dirs]


def copy_upstream(tree: Path) -> None:
    if tree.exists():
        shutil.rmtree(tree)
    tree.parent.mkdir(parents=True, exist_ok=True)
    p = run(["robocopy", str(UP), str(tree), "/E", "/XD", ".git", "/NFL", "/NDL",
             "/NJH", "/NJS", "/NC", "/NS", "/NP"], LOGS / "copy-upstream.log")
    # robocopy: 0..7 are success codes.
    if p.returncode > 7:
        raise Failed(f"robocopy failed ({p.returncode}): {(p.stdout or '')[-800:]}")


def apply_t005d(tree: Path) -> list[str]:
    """Apply the T-005d patch on top of the scheduler+file tree.

    Unlike engine/apply_file_overlay.py this reads each modified file from the
    *tree*, because the patch's base is the already-overlaid source, not
    upstream.  An empty patch is the measured result of this spike and applies
    no files.
    """
    if not PATCH.is_file():
        raise Blocked(f"missing patch: {PATCH}")
    raw = PATCH.read_text(encoding="utf-8") if PATCH.stat().st_size else ""
    if not raw.strip():
        return []
    files = ao.parse_patch(raw)
    touched: list[str] = []
    for f in files:
        rel = f["rel"]
        dst = tree / rel
        if f["is_new"]:
            dst.parent.mkdir(parents=True, exist_ok=True)
            lines = ao.apply_hunks(rel, [], f["hunks"])
            dst.write_bytes(("\n".join(lines) + "\n").encode("utf-8"))
        else:
            if not dst.is_file():
                raise Failed(f"patch base missing in tree: {rel}")
            rawb = dst.read_bytes()
            eol = "\r\n" if b"\r\n" in rawb else "\n"
            text = rawb.decode("utf-8").replace("\r\n", "\n").replace("\r", "\n")
            trailing = text.endswith("\n")
            body = text[:-1] if trailing else text
            lines = ao.apply_hunks(rel, body.split("\n") if body else [], f["hunks"])
            out = eol.join(lines) + (eol if trailing else "")
            dst.write_bytes(out.encode("utf-8"))
        touched.append(rel)
    return touched


def warning_gate() -> dict:
    """No warning may be attributed to the harness itself (-Wall -Wextra -Wpedantic)."""
    extra = ["-Wall", "-Wextra", "-Wpedantic", "-Wno-unused-parameter", "-fsyntax-only"]
    p = run([sys.executable, str(EM), *FLAGS, *extra, *includes("harness"),
             str(HARNESS / "gravity_harness.cpp")], LOGS / "warning-gate.log")
    if p.returncode:
        raise Failed("warning gate failed to compile gravity_harness.cpp\n"
                     + ((p.stdout or "") + (p.stderr or ""))[-2000:])
    text = (p.stdout or "") + (p.stderr or "")
    ours = [line for line in text.splitlines()
            if line.startswith("engine/harness/t005d/gravity_harness.cpp") and ": warning:" in line]
    if ours:
        raise Failed("warnings attributed to gravity_harness.cpp:\n  " + "\n  ".join(ours[:20]))
    return {"warnings": 0, "flags": "-Wall -Wextra -Wpedantic -Wno-unused-parameter"}


def gravity_tree_unchanged() -> dict:
    """Every file under the tree's gravity directory must be byte-identical to upstream."""
    a = TREE / GRAVITY
    b = UP / GRAVITY
    checked = 0
    changed = []
    for src in b.rglob("*"):
        if not src.is_file():
            continue
        rel = src.relative_to(b)
        dst = a / rel
        checked += 1
        if not dst.is_file() or dst.read_bytes() != src.read_bytes():
            changed.append(str(rel))
    if changed:
        raise Failed("Gravity source differs from upstream: " + ", ".join(changed[:10]))
    return {"files": checked, "changed": 0}


def build(tag: str):
    objdir = OUT / f"obj_{tag}"
    if objdir.exists():
        shutil.rmtree(objdir)
    objdir.mkdir(parents=True)
    objs = []
    for i, (rel, kind) in enumerate(TUS):
        src = (ROOT / rel) if rel.startswith(("engine/", "_work/")) else (TREE / rel)
        obj = objdir / f"{i:02d}_{src.stem}.o"
        p = run([sys.executable, str(EM), *FLAGS, *includes(kind), "-c", str(src), "-o", str(obj)],
                LOGS / f"{tag}__{src.stem}.log")
        if p.returncode:
            raise Failed(f"compile failed: {rel}\n" + ((p.stdout or "") + (p.stderr or ""))[-3000:])
        objs.append(obj)

    js = OUT / f"gravity_{tag}.mjs"
    p = run([sys.executable, str(EM), *objs, *LINK_FLAGS, "-o", str(js)],
            LOGS / f"{tag}__link.log")
    if p.returncode:
        raise Failed("link failed\n" + ((p.stdout or "") + (p.stderr or ""))[-3000:])
    return js, len(objs)


def run_harness(js: Path, out_json: Path):
    p = run([str(NODE), str(HARNESS / "run_gravity_wasm.mjs"), str(js), str(LEVEL), str(out_json)],
            LOGS / f"run__{out_json.stem}.log")
    text = (p.stdout or "") + (p.stderr or "")
    if p.returncode != 0:
        raise Failed(f"node harness failed ({p.returncode}): {text[-2000:]}")
    return text


def ensure_oracle() -> None:
    if ORACLE.is_file():
        return
    if not ORACLE_RUNNER.is_file():
        raise Blocked(f"no oracle document at {ORACLE} and no probe runner")
    p = run([sys.executable, str(ORACLE_RUNNER), "--skip-build"], LOGS / "oracle-run.log")
    if p.returncode != 0 or not ORACLE.is_file():
        raise Blocked(
            f"the committed oracle document is missing and the probe could not be run:\n"
            f"{(p.stdout or '')[-1000:]}{(p.stderr or '')[-1000:]}\n"
            f"run: python probes/collision-oracle/tests/run_collision_oracle.py")


# ------------------------------------------------------------------ record layout

RAY_FIELDS = [
    (0, "kind"), (1, "hit"), (2, "pad"), (4, "queryIndex"), (8, "mesh"), (12, "leaf"),
    (16, "triangleOrdinal"), (20, "engineTriangleIndex"), (24, "header"),
    (28, "collisionFlags"), (32, "physicsMaterial"), (36, "effectMaterial"),
    (40, "userData"), (44, "normalPacked"), (48, "contact.x"), (52, "contact.y"),
    (56, "contact.z"), (60, "normal.x"), (64, "normal.y"), (68, "normal.z"),
    (72, "distance"), (76, "bodiesTested"),
]
SPHERE_CONTACT_FIELDS = [
    (0, "mesh"), (4, "triangleOrdinal"), (8, "engineHashValue"), (12, "patch"),
    (16, "physicsMaterial"), (20, "effectMaterial"), (24, "point.x"), (28, "point.y"),
    (32, "point.z"), (36, "normal.x"), (40, "normal.y"), (44, "normal.z"),
    (48, "penetration"),
]
CACHE_ENTRY_FIELDS = [
    (0, "engineTriangleIndex"), (4, "triangleOrdinal"), (8, "leaf"),
    (12, "collisionFlags"), (16, "physicsMaterial"), (20, "effectMaterial"),
    (24, "userData"), (28, "normalPacked"), (32, "a.x"), (36, "a.y"), (40, "a.z"),
    (44, "b.x"), (48, "b.y"), (52, "b.z"), (56, "c.x"), (60, "c.y"), (64, "c.z"),
]
CACHE_TRACE_FIELDS = [
    (0, "engineTriangleIndex"), (4, "triangleOrdinal"), (8, "leaf"),
    (12, "collisionFlags"), (16, "physicsMaterial"), (20, "effectMaterial"),
    (24, "userData"), (28, "normalPacked"), (32, "contact.x"), (36, "contact.y"),
    (40, "contact.z"), (44, "normal.x"), (48, "normal.y"), (52, "normal.z"),
    (56, "distance"),
]


def field_at(kind: str, offset: int) -> str:
    """Name the canonical-record field at a byte offset."""
    def pick(fields, off):
        name = "?"
        for at, n in fields:
            if at <= off:
                name = n
            else:
                break
        return name

    if kind == "rays":
        return pick(RAY_FIELDS, offset)
    if kind == "spheres":
        if offset < 32:
            return pick([(0, "kind"), (1, "hit"), (2, "pad"), (4, "queryIndex"),
                         (8, "radius"), (12, "centre.x"), (16, "centre.y"), (20, "centre.z"),
                         (24, "headersFiltered"), (28, "contactCount")], offset)
        rel = offset - 32
        return f"contact[{rel // 52}].{pick(SPHERE_CONTACT_FIELDS, rel % 52)}"
    return "?"


def cache_field_at(record: bytes, offset: int) -> str:
    if offset < 32:
        names = [(0, "kind"), (1, "hit"), (2, "pad"), (4, "queryIndex"),
                 (8, "cachedTriangles"), (12, "bodiesConsidered"), (16, "bodiesAccepted"),
                 (20, "headersFiltered"), (24, "trianglesTested"),
                 (28, "trianglesRejectedByNormal")]
        for at, n in reversed(names):
            if offset >= at:
                return n
        return "?"
    n = struct.unpack_from("<I", record, 8)[0]
    entries_end = 32 + 68 * n
    if offset < entries_end:
        rel = offset - 32
        return f"entry[{rel // 68}].{pick_named(CACHE_ENTRY_FIELDS, rel % 68)}"
    rel = offset - entries_end
    return f"trace.{pick_named(CACHE_TRACE_FIELDS, rel)}"


def pick_named(fields, off):
    name = "?"
    for at, n in fields:
        if at <= off:
            name = n
        else:
            break
    return name


def compare_records(engine: dict, oracle: dict) -> dict:
    first = None
    per_kind = {}
    order = 0
    for kind in ("rays", "spheres", "cacheQueries"):
        gm = {x["label"]: x for x in engine[kind]}
        om = {x["label"]: x for x in oracle[kind]}
        same = differing = 0
        fields = {}
        for label in om:
            g = gm.get(label)
            if g is None:
                raise Failed(f"engine document is missing {label}")
            a = bytes.fromhex(g["record"])
            b = bytes.fromhex(om[label]["record"])
            if len(a) != len(b):
                raise Failed(f"{label}: record length {len(a)} != oracle {len(b)}")
            if a == b:
                same += 1
            else:
                differing += 1
                for i in range(len(a)):
                    if a[i] != b[i]:
                        if kind == "cacheQueries":
                            name = cache_field_at(b, i)
                        elif kind == "rays":
                            name = field_at("rays", i)
                        else:
                            name = field_at("spheres", i)
                        base = name
                        if name.startswith("contact["):
                            base = "contact." + name.split("].", 1)[1]
                        elif name.startswith("entry["):
                            base = "entry." + name.split("].", 1)[1]
                        fields[base] = fields.get(base, 0) + 1
                        if first is None:
                            first = {
                                "canonicalQueryIndex": order,
                                "kind": kind,
                                "label": label,
                                "byteOffset": i,
                                "field": name,
                                "engineByte": a[i],
                                "probeByte": b[i],
                                "engineRecord": g["record"],
                                "probeRecord": om[label]["record"],
                            }
            order += 1
        per_kind[kind] = {"same": same, "different": differing,
                          "divergentFields": dict(sorted(fields.items()))}
    return {"first": first, "kinds": per_kind}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fresh", action="store_true", help="re-copy upstream first")
    ap.add_argument("--skip-build", action="store_true", help="reuse the last wasm modules")
    ap.add_argument("--require-hash", action="store_true",
                    help="fail unless queryHash equals the committed oracle hash")
    ap.add_argument("--report", default=str(LOGS / "verify-gravity.json"))
    args = ap.parse_args()

    LOGS.mkdir(parents=True, exist_ok=True)
    OUT.mkdir(parents=True, exist_ok=True)
    started = time.time()
    report = {"purpose": "T-005d gravity static-collision overlay verification",
              "status": "running", "blockers": [], "commands": []}

    if not EM.is_file():
        raise Blocked(f"emsdk em++ missing: {EM}")
    if not NODE.is_file():
        raise Blocked(f"emsdk node missing: {NODE}")
    if not LEVEL.is_file():
        raise Blocked(f"level file missing: {LEVEL}")
    ensure_oracle()
    oracle = json.loads(ORACLE.read_text(encoding="utf-8"))
    if oracle.get("status") != "ok":
        raise Blocked("the oracle document is not a successful run")

    if args.fresh or not TREE.exists():
        copy_upstream(TREE)
        report["tree"] = "fresh copy of upstream"
    else:
        report["tree"] = "reused"
    report["commands"].append("robocopy upstream/BlurRebuilt _work/engine-gravity-spike/tree /E /XD .git")

    p = run([sys.executable, str(ROOT / "engine/apply_file_overlay.py"), "--tree", str(TREE)],
            LOGS / "apply.log")
    report["commands"].append("python engine/apply_file_overlay.py --tree _work/engine-gravity-spike/tree")
    if p.returncode != 0:
        raise Failed((p.stderr or p.stdout).strip())
    report["overlay"] = json.loads((TREE / ".overlay/file-overlay.json").read_text(encoding="utf-8"))

    touched = apply_t005d(TREE)
    report["patch"] = {
        "path": str(PATCH.relative_to(ROOT)),
        "bytes": PATCH.stat().st_size,
        "sha256": sha256_file(PATCH),
        "files": touched,
        "note": ("empty patch: the T-005c scheduler + T-005b file overlays already compile "
                 "the Gravity TUs this spike needs; no engine source change was required"),
    }
    report["commands"].append("python engine/verify_gravity.py  (applies t005d-gravity-overlay.patch)")

    if args.skip_build:
        a_js = OUT / "gravity_a.mjs"
        b_js = OUT / "gravity_b.mjs"
        if not a_js.is_file() or not b_js.is_file():
            raise Blocked("--skip-build but the wasm modules are missing; run without it")
        objects = len(TUS)
    else:
        t0 = time.time()
        a_js, objects = build("a")
        b_js, _ = build("b")
        report["buildSeconds"] = round(time.time() - t0, 1)
    report["commands"] += [
        "em++ <gravity + closing TUs> -O2 -ffp-contract=off -fno-fast-math ... -o gravity_a.mjs",
        "node engine/harness/t005d/run_gravity_wasm.mjs gravity_a.mjs Level.levelphysics gravity_a.json",
    ]

    if not args.skip_build:
        report["warningGate"] = warning_gate()
    report["gravityTree"] = gravity_tree_unchanged()

    wasm_a = a_js.with_suffix(".wasm")
    wasm_b = b_js.with_suffix(".wasm")
    hash_a = sha256_file(wasm_a)
    hash_b = sha256_file(wasm_b)
    report["wasm"] = {
        "bytes": wasm_a.stat().st_size,
        "sha256": hash_a,
        "rebuild_sha256": hash_b,
        "deterministic": hash_a == hash_b,
        "objects": objects,
        "tus": [rel for rel, _ in TUS],
    }
    if hash_a != hash_b:
        raise Failed(f"the wasm build is not deterministic: {hash_a[:16]} != {hash_b[:16]}")

    out_a = SPIKE / "gravity_a.json"
    out_b = SPIKE / "gravity_b.json"
    run_harness(a_js, out_a)
    run_harness(b_js, out_b)
    text_a = out_a.read_bytes()
    text_b = out_b.read_bytes()
    report["run"] = {
        "documentBytes": len(text_a),
        "repeatIdentical": text_a == text_b,
        "sha256": hashlib.sha256(text_a).hexdigest(),
    }
    if text_a != text_b:
        raise Failed("two runs of the same module produced different documents")

    engine = json.loads(text_a.decode("utf-8"))
    if engine.get("status") != "ok":
        raise Failed(f"harness reported {engine.get('status')}: {json.dumps(engine.get('error'))}")

    for i, expected in enumerate(EXPECTED_MESHES):
        got = engine["meshes"][i]
        for key, value in expected.items():
            if got.get(key) != value:
                raise Failed(f"mesh {i} {key}: engine {got.get(key)} != oracle {value}")
        oracle_mesh = oracle["meshes"][i]
        for key in ("numVertices", "numNormals", "numTriangles", "numLeaves", "numNodes"):
            if got.get(key) != oracle_mesh.get(key):
                raise Failed(f"mesh {i} {key}: engine {got.get(key)} != oracle {oracle_mesh.get(key)}")
    report["structure"] = {"meshes": len(engine["meshes"]), "matchesOracle": True}

    def input_mismatches(kind, keys):
        gm = {x["label"]: x for x in engine[kind]}
        om = {x["label"]: x for x in oracle[kind]}
        out = []
        for label in om:
            for key in keys:
                if key in om[label] and gm[label].get(key) != om[label].get(key):
                    out.append({"label": label, "field": key})
        return out

    report["fixtureInputs"] = {
        "rays": input_mismatches("rays", ["start", "direction", "maxCosAngle", "maxDistance"]),
        "spheres": input_mismatches("spheres", ["centre", "radius"]),
        "cacheBoxes": "not present in the oracle document; identical within the harness's own derivation",
    }
    if report["fixtureInputs"]["rays"] or report["fixtureInputs"]["spheres"]:
        raise Failed(f"the query fixture differs from the oracle: {report['fixtureInputs']}")

    cmp = compare_records(engine, oracle)
    report["records"] = cmp["kinds"]
    report["firstDivergence"] = cmp["first"]

    def check_documented_divergence():
        for kind, expected in EXPECTED_DIVERGENCE.items():
            got = cmp["kinds"][kind]
            if got["same"] != expected["same"] or got["different"] != expected["different"]:
                raise Failed(
                    f"{kind}: {got['same']} same/{got['different']} different, "
                    f"expected {expected['same']}/{expected['different']}")
            if got["divergentFields"] != expected["fields"]:
                raise Failed(
                    f"{kind}: divergent fields changed: {got['divergentFields']} "
                    f"!= {expected['fields']}")
        first = cmp["first"]
        for key, value in EXPECTED_FIRST_DIVERGENCE.items():
            if first is None or first.get(key) != value:
                got = None if first is None else first.get(key)
                raise Failed(f"first divergence {key}: {got} != {value}")

    check_documented_divergence()
    report["hashes"] = {
        "expected": EXPECTED_QUERY_HASH,
        "engine": engine["hashes"]["queryHash"],
        "equal": engine["hashes"]["queryHash"] == EXPECTED_QUERY_HASH,
        "canonicalRecordBytes": engine["hashes"]["canonicalRecordBytes"],
        "expectedCanonicalRecordBytes": EXPECTED_RECORD_BYTES,
    }
    if engine["hashes"]["canonicalRecordBytes"] != EXPECTED_RECORD_BYTES:
        raise Failed("canonical record byte count differs from the oracle")

    if report["hashes"]["equal"]:
        report["status"] = "PASS"
    else:
        report["status"] = "DIVERGED (documented)"
        if args.require_hash:
            raise Failed("queryHash differs from the committed oracle hash")

    report["pcPath"] = {
        "engineSourceEdits": len(touched),
        "note": ("no PC edits: the T-005d patch is empty and the harness only reads the "
                 "overlaid tree; every compiled file is upstream or an existing overlay file"),
    }
    report["elapsedSeconds"] = round(time.time() - started, 1)

    report_path = Path(args.report)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

    print(f"tree            {TREE}")
    print(f"patch           {PATCH.name} {PATCH.stat().st_size} B sha256={report['patch']['sha256'][:16]}")
    print(f"wasm            {report['wasm']['bytes']} B {hash_a[:16]} ({objects} objects)")
    print(f"deterministic   build={report['wasm']['deterministic']} run={report['run']['repeatIdentical']}")
    print(f"meshes          {report['structure']['meshes']} (counts match the oracle)")
    for kind, v in report["records"].items():
        print(f"{kind:<14} same={v['same']} different={v['different']} fields={v['divergentFields']}")
    print(f"queryHash       engine {report['hashes']['engine']}")
    print(f"                oracle {EXPECTED_QUERY_HASH}  equal={report['hashes']['equal']}")
    if report["firstDivergence"]:
        f = report["firstDivergence"]
        print(f"first divergent query {f['canonicalQueryIndex']} {f['label']} byte {f['byteOffset']} "
              f"field {f['field']} (engine {f['engineByte']:02x} probe {f['probeByte']:02x})")
    print(f"status          {report['status']}")
    print(f"report          {report_path}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Blocked as exc:
        print(f"verify_gravity: BLOCKED: {exc}", file=sys.stderr)
        raise SystemExit(3)
    except Failed as exc:
        print(f"verify_gravity: FAILED: {exc}", file=sys.stderr)
        raise SystemExit(2)
