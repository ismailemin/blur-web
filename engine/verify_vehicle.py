"""Verify the T-005d vehicle-physics spike: real RacingPhysics + Gravity on wasm32.

    python engine/verify_vehicle.py --fresh       # fresh tree, patch, build x2, run x2
    python engine/verify_vehicle.py               # reuse the tree and the modules
    python engine/verify_vehicle.py --skip-build  # reuse the modules, run again
    python engine/verify_vehicle.py --make-patch  # regenerate the committed patch

What it does, in order:
  1. copies upstream/BlurRebuilt to _work/engine-vehicle-spike/tree (optional),
  2. applies the T-005c scheduler + T-005b file overlays and then
     engine/patches/t005d-vehicle-overlay.patch,
  3. decodes gamedata\\xt\\racingphysics.bin (through the installed gamedata.pak)
     and turns the RP_CarDynamics record for Corvette_ZR1_Stock into the field
     list the harness consumes (car_xt.py),
  4. compiles the RacingPhysics vehicle TUs, the Gravity library TUs and the
     logging/platform closure for wasm32 twice and compares the .wasm hashes,
  5. runs the module twice on usa_la_river/Level.levelphysics and compares the
     JSON byte for byte,
  6. checks the physics result shape: no NaN, wheel contacts during the settle
     phase, acceleration under throttle, bounded settle speed,
  7. checks PC parity: preprocesses every patched file with MSVC in the PC
     configuration from upstream and from the tree and compares the result,
  8. records the native-vs-wasm attempt and its exact blocker.

Stdlib only. Reads upstream, game data and the toolchain; writes only under
_work/engine-vehicle-spike/ and _work/logs/engine-vehicle-spike/.
"""
from __future__ import annotations

import argparse
import difflib
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
sys.path.insert(0, str(ROOT / "engine/harness/t005d-vehicle"))
import apply_overlay as ao  # noqa: E402
import car_xt  # noqa: E402

UP = ROOT / "upstream/BlurRebuilt"
SPIKE = ROOT / "_work/engine-vehicle-spike"
TREE = SPIKE / "tree"
OUT = SPIKE / "out"
LOGS = ROOT / "_work/logs/engine-vehicle-spike"
HARNESS = ROOT / "engine/harness/t005d-vehicle"
EM = ROOT / "_work/toolchains/emsdk/upstream/emscripten/em++.py"
NODE = ROOT / "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"
LEVEL = ROOT / "game-data/Blur/levels/usa_la_river/Level.levelphysics"
GAME = ROOT / "game-data/Blur"
PATCH = ROOT / "engine/patches/t005d-vehicle-overlay.patch"

COMMON = "code/mercury/library/common"
GRAVITY = "code/mercury/library/physics/gravity"
RP = "code/mercury/library/physics/racingphysics"

# The start point is the contact x/z of the committed collision-oracle fixture
# `ray-random-21` (surface normal 0.000/0.999/0.000: a flat piece of road).
START_X = 281.2833
START_Z = 1823.6890
SETTLE_TICKS = 180
DRIVE_TICKS = 300
THROTTLE = 1.0
STEER = 0.0
DT = 1.0 / 60.0
CAR_NAME = "Corvette_ZR1_Stock"

FLAGS = [
    "-DBUILD_CONFIG_SPEED", "-DPLATFORM_WEB", "-std=c++14", "-O2",
    "-fno-fast-math", "-ffp-contract=off",
    "-fdelayed-template-parsing", "-D__restrict=", "-fdeclspec",
    "-DUSE_SOLVER_2",
    "-Wno-nonportable-include-path", "-Wno-ignored-attributes",
    "-Wno-deprecated-register", "-Wno-return-type", "-Wno-c++20-extensions",
    "-include", str(ROOT / "engine/harness/t005b/msvc_crt_web.h"),
    "-include", str(ROOT / "engine/harness/t005c/web_platform.h"),
]

LINK = [
    "-O2", "-fno-fast-math", "-ffp-contract=off",
    "-sMODULARIZE=1", "-sEXPORT_ES6=1", "-sENVIRONMENT=node,web",
    "-sALLOW_MEMORY_GROWTH=1", "-sINITIAL_MEMORY=268435456",
    "-sMAXIMUM_MEMORY=536870912", "-sSTACK_SIZE=8388608", "--no-entry",
    "-sERROR_ON_UNDEFINED_SYMBOLS=1",
    "-sEXPORTED_FUNCTIONS=_vehicle_run,_malloc,_free",
    "-sEXPORTED_RUNTIME_METHODS=UTF8ToString,HEAPU8",
]

RP_TUS = [
    "physics/articulatedbody.cpp", "physics/axis.cpp", "physics/quaternion.cpp",
    "physics/rotationmatrix.cpp", "physics/rigidbody.cpp", "physics/constraints.cpp",
    "physics/surfaces.cpp", "physics/physicstimer.cpp", "physics/physics.cpp",
    "physics/parameters.cpp", "physics/compressfloat.cpp",
    "vehicles/vehicle.cpp", "vehicles/integrate.cpp",
    "vehicles/Car/car.cpp", "vehicles/Car/carwheel.cpp", "vehicles/Car/carengine.cpp",
    "vehicles/Car/carnetworkphysics.cpp", "vehicles/Car/networkupdate.cpp",
    "vehicles/Car/cartransmission.cpp", "vehicles/Car/carsettings.cpp",
    "vehicles/debugsliprecorder.cpp",
    "collisions/boundingbox.cpp", "collisions/roots3and4.cpp",
]

GV_DIRS = ["sdk", "importer", "narrowphase", "sharedphysics", "broadphase",
           "solver2", "treebuilder", "Triggers", "cloths"]

# Excluded Gravity TUs, each for a measured reason (docs/work/analysis/
# engine-vehicle-physics.md section 2):
GV_EXCLUDE = {
    "sdk/Scene_DebugRender.cpp",            # Display / DX11
    "narrowphase/GJKSPU.cpp",               # SPU-only
    "narrowphase/CollisionManager_Rope.cpp",  # rope headers are not web-portable
    "cloths/ClothCollision.cpp",            # cloth headers are not web-portable
    "cloths/RopePrimitiveCollision.cpp",    # rope headers are not web-portable
    "solver2/Link.cpp",                     # Featherstone multibody; unused
    "solver2/Multibody.cpp",                # Featherstone multibody; unused
}

COMMON_TUS = [
    (f"{COMMON}/system/source/scheduler/jobqueue.cpp", "system"),
    (f"{COMMON}/system/source/scheduler/jobqueue_kernel.cpp", "system"),
    (f"{COMMON}/system/source/scheduler/jobqueue_task_queue_lf.cpp", "system"),
    (f"{COMMON}/system/source/scheduler/jobqueue_mem.cpp", "system"),
    (f"{COMMON}/system/source/scheduler/jobqueue_web.cpp", "system"),
    (f"{COMMON}/core/source/maths/Constants.cpp", "core"),
    (f"{COMMON}/core/source/maths/hvec/VectorConst.cpp", "core"),
    (f"{COMMON}/core/source/maths/hvec/Trigonometry.cpp", "core"),
    (f"{COMMON}/core/source/maths/hvec/New/Vec4F32.cpp", "core"),
    (f"{COMMON}/core/source/maths/hvec/New/VF32.cpp", "core"),
    (f"{COMMON}/core/source/maths/hvec/New/Mat33.cpp", "core"),
    (f"{COMMON}/core/source/maths/hvec/New/Euler.cpp", "core"),
    (f"{COMMON}/core/source/maths/hvec/TableTan.cpp", "core"),
    (f"{COMMON}/core/source/maths/hvec/TableArcSin.cpp", "core"),
    (f"{COMMON}/core/source/maths/hvec/TableArcTan.cpp", "core"),
    (f"{COMMON}/core/source/maths/hvec/TableBernoulli.cpp", "core"),
    (f"{COMMON}/core/source/maths/hvec/TableSin.cpp", "core"),
    (f"{COMMON}/core/source/maths/hvec/TableCos.cpp", "core"),
    (f"{COMMON}/core/source/maths/hvec/TableExp.cpp", "core"),
    (f"{COMMON}/core/source/maths/hvec/TableLog.cpp", "core"),
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
]

# (path relative to the tree, whether the patch is web-only for that file)
PATCHED_FILES = [
    (f"{GRAVITY}/source/sdk/Body.cpp", False),
    (f"{GRAVITY}/source/sdk/SPUScene.cpp", True),
    (f"{GRAVITY}/source/importer/InstanceMeshResourceManager.cpp", False),
    (f"{RP}/include/racingphysics/Vehicles/Car/car.h", True),
    (f"{RP}/source/vehicles/Car/car.cpp", True),
    (f"{RP}/source/vehicles/Car/carsettings.cpp", True),
    (f"{RP}/source/physics/surfaces.cpp", True),
    (f"{RP}/source/physics/parameters.cpp", True),
    (f"{RP}/source/vehicles/debugsliprecorder.cpp", True),
]

VCVARS = Path(r"C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat")


class Failed(RuntimeError):
    pass


class Blocked(RuntimeError):
    pass


def run(cmd, log=None, shell=False):
    p = subprocess.run([str(c) for c in cmd] if not shell else cmd,
                       capture_output=True, text=True, errors="replace")
    if log is not None:
        log.parent.mkdir(parents=True, exist_ok=True)
        log.write_text("$ " + " ".join(str(c) for c in cmd) + "\n"
                       + (p.stdout or "") + (p.stderr or ""), encoding="utf-8", errors="replace")
    return p


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def includes(kind: str) -> list[str]:
    common = TREE / COMMON
    core = [common / "core/include", common / "core", common / "system/include", common / "btl/include"]
    system = core + [common / "system", common / "system/source/scheduler",
                     common / "misc_shared", common / "misc_shared/include", common / "xt2/include"]
    gravity = [TREE / GRAVITY, TREE / GRAVITY / "include"]
    rp = [TREE / RP, TREE / RP / "include"]
    d = [HARNESS / "display_shim"]
    if kind in ("rp", "harness"):
        d += rp + system + gravity
    elif kind == "gravity":
        d += gravity + system
    elif kind == "core":
        d += core
    else:
        d += system
    if kind == "harness":
        d.append(HARNESS)
    return ["-I" + str(x) for x in d]


def gravity_tus() -> list[str]:
    out = []
    for d in GV_DIRS:
        for f in sorted((TREE / GRAVITY / "source" / d).glob("*.cpp")):
            rel = f"{d}/{f.name}"
            if rel not in GV_EXCLUDE:
                out.append(rel)
    return out


def jobs() -> list[tuple[str, str]]:
    out = [(f"{RP}/source/{rel}", "rp") for rel in RP_TUS]
    out += [(f"{GRAVITY}/source/{rel}", "gravity") for rel in gravity_tus()]
    out += COMMON_TUS
    out.append(("engine/harness/t005d-vehicle/vehicle_harness.cpp", "harness"))
    return out


# --------------------------------------------------------------------- tree


def copy_upstream() -> None:
    if TREE.exists():
        shutil.rmtree(TREE)
    TREE.parent.mkdir(parents=True, exist_ok=True)
    p = run(["robocopy", str(UP), str(TREE), "/E", "/XD", ".git", "/NFL", "/NDL",
             "/NJH", "/NJS", "/NC", "/NS", "/NP"], LOGS / "copy-upstream.log")
    if p.returncode > 7:
        raise Failed(f"robocopy failed ({p.returncode})")


def apply_vehicle_patch(tree: Path) -> list[str]:
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
            # Reset the base: the two published overlays do not touch these files,
            # so the patch base is the upstream file. Copying it in makes every run
            # idempotent instead of depending on whether the tree is already patched.
            src = UP / rel
            if not src.is_file():
                raise Failed(f"upstream file missing: {rel}")
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_bytes(src.read_bytes())
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


def make_patch() -> str:
    """Generate the unified diff (base = upstream) for the edited tree."""
    chunks = []
    for rel, _web_only in PATCHED_FILES:
        old_lines = _read_lf(UP / rel)
        new_lines = _read_lf(TREE / rel)
        if old_lines == new_lines:
            raise Failed(f"{rel}: no change; the tree does not contain the overlay")
        diff = difflib.unified_diff(old_lines, new_lines, fromfile=f"a/{rel}",
                                    tofile=f"b/{rel}", lineterm="", n=3)
        chunks.append("\n".join(diff) + "\n")
    return "".join(chunks)


def _read_lf(path: Path) -> list[str]:
    with path.open("r", encoding="utf-8", newline="") as fh:
        text = fh.read()
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    lines = text.split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    return lines


# --------------------------------------------------------------------- build


def build(tag: str) -> tuple[Path, int]:
    objdir = OUT / f"obj_{tag}"
    if objdir.exists():
        shutil.rmtree(objdir)
    objdir.mkdir(parents=True)
    objs = []
    for i, (rel, kind) in enumerate(jobs()):
        src = ROOT / rel if not rel.startswith("code/") else TREE / rel
        obj = objdir / f"{i:03d}_{src.stem}.o"
        p = run([sys.executable, str(EM), *FLAGS, *includes(kind), "-c", str(src), "-o", str(obj)],
                LOGS / f"{tag}__{i:03d}_{src.stem}.log")
        if p.returncode:
            errs = [l for l in ((p.stdout or "") + (p.stderr or "")).splitlines() if "error:" in l]
            raise Failed(f"compile failed: {rel}\n" + "\n".join(errs[:6]))
        objs.append(obj)
    js = OUT / f"vehicle_{tag}.mjs"
    p = run([sys.executable, str(EM), *[str(o) for o in objs], *LINK, "-o", str(js)],
            LOGS / f"link_{tag}.log")
    if p.returncode:
        text = (p.stdout or "") + (p.stderr or "")
        undef = sorted({l.split("undefined symbol: ")[-1].strip()
                        for l in text.splitlines() if "undefined symbol" in l})
        raise Failed("link failed\n" + "\n".join(undef[:20]))
    return js, len(objs)


def run_harness(js: Path, fields: Path, out_json: Path) -> str:
    p = run([str(NODE), str(HARNESS / "run_vehicle_wasm.mjs"), str(js), str(LEVEL),
             str(fields), str(out_json)], LOGS / f"run__{out_json.stem}.log")
    if p.returncode != 0:
        raise Failed(f"node harness failed ({p.returncode}): "
                     f"{((p.stdout or '') + (p.stderr or ''))[-1500:]}")
    return p.stdout or ""


# -------------------------------------------------------------------- checks


def f32(h: str) -> float:
    return struct.unpack(">f", bytes.fromhex(h))[0]


def check_document(doc: dict, evidence: dict) -> dict:
    if doc.get("status") != "ok":
        raise Failed(f"harness reported {doc.get('status')}: {json.dumps(doc.get('error'))}")
    summary = doc["summary"]
    scenario = doc["scenario"]
    ticks = doc["ticks"]

    if summary["nanTicks"] != 0:
        raise Failed(f"{summary['nanTicks']} ticks contain NaN/Inf")
    if any(not t["finite"] for t in ticks):
        raise Failed("a tick is flagged non-finite")
    if summary["overflow"]:
        raise Failed("the JSON output buffer overflowed")

    # wheel contacts during the settle phase: the last settle tick must have all
    # four wheels on the ground (the car is resting on the road)
    last_settle = ticks[SETTLE_TICKS - 1]
    if last_settle["g"] != [1, 1, 1, 1]:
        raise Failed(f"settle tick {SETTLE_TICKS - 1} contact flags {last_settle['g']}")

    settle_speed = f32(summary["maxSettleSpeed"])
    if settle_speed > 2.0:
        raise Failed(f"the car did not settle: max speed {settle_speed:.3f} m/s")

    speed_start = f32(ticks[SETTLE_TICKS - 1]["speed"])
    speed_end = f32(ticks[-1]["speed"])
    if speed_end <= speed_start + 10.0:
        raise Failed(f"throttle did not accelerate the car: {speed_start:.2f} -> {speed_end:.2f} m/s")
    distance = f32(summary["driveDistance"])
    if distance < 50.0:
        raise Failed(f"driven distance {distance:.1f} m is too small for the scenario")

    # the car's own dynamics must be the decoded XT record
    if scenario["car"] != CAR_NAME:
        raise Failed(f"scenario car {scenario['car']} is not {CAR_NAME}")
    mass = f32(scenario["mass"])
    if abs(mass - 1600.0) > 1e-3:
        raise Failed(f"car mass {mass} is not the XT record's 1600 kg")

    # a frozen or stuck simulation shows up as long runs of identical tick states
    hashes = [t["h"] for t in ticks]
    distinct = len(set(hashes))
    if distinct < len(ticks) - 5:
        raise Failed(f"only {distinct} distinct tick hashes of {len(ticks)}: the state is frozen")

    return {
        "ticks": len(ticks),
        "contactTicks": summary["contactTicks"],
        "nanTicks": summary["nanTicks"],
        "maxSettleSpeedMps": round(settle_speed, 4),
        "speedAtThrottleStartMps": round(speed_start, 4),
        "finalSpeedMps": round(speed_end, 4),
        "driveDistanceM": round(distance, 3),
        "finalPosition": [round(f32(v), 3) for v in summary["finalPosition"]],
        "bestSpeedMps": round(max(f32(t["speed"]) for t in ticks), 4),
        "distinctTickHashes": distinct,
        "settleStateHash": summary["settleStateHash"],
        "driveStateHash": summary["driveStateHash"],
        "allStateHash": summary["allStateHash"],
        "canonicalTickBytes": summary["canonicalTickBytes"],
    }


# ---------------------------------------------------------------- pc parity


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def msvc_preprocess(rel: str, source_root: Path, log: Path) -> tuple[int, str]:
    tree = source_root
    t = tree / COMMON
    inc = [
        f'-I"{HARNESS / "display_shim"}"',
        f'-I"{tree / RP}"', f'-I"{tree / RP / "include"}"',
        f'-I"{t / "core/include"}"', f'-I"{t / "core"}"',
        f'-I"{t / "system/include"}"', f'-I"{t / "btl/include"}"',
        f'-I"{t / "system"}"', f'-I"{t / "system/source/scheduler"}"',
        f'-I"{t / "misc_shared"}"', f'-I"{t / "misc_shared/include"}"',
        f'-I"{t / "xt2/include"}"',
        f'-I"{tree / GRAVITY}"', f'-I"{tree / GRAVITY / "include"}"',
    ]
    bat = SPIKE / "cl.bat"
    if not bat.is_file():
        bat.write_text(
            "@echo off\n"
            f'call "{VCVARS}" >nul 2>&1\n'
            "if errorlevel 1 ( echo VCVARS-FAIL & exit /b 2 )\n"
            "cl %*\n", encoding="ascii")
    cmd = (f'"{bat}" /nologo /E /TP /std:c++14 /DBUILD_CONFIG_SPEED /DPLATFORM_PC '
           f'/DWIN32 /D_WINDOWS {" ".join(inc)} "{source_root / rel}"')
    p = run(cmd, log, shell=True)
    return p.returncode, (p.stdout or "") + (p.stderr or "")


def normalise_preprocessed(text: str) -> str:
    """Drop MSVC line markers and source-location metadata.

    Adding lines necessarily shifts the ``__LINE__``/``__FILE__`` a LOG macro
    records, and the baseline tree has a different directory name. Both are
    metadata about where a statement is, not what it does, so they are
    normalised away before the comparison.
    """
    out = []
    for line in text.splitlines():
        s = line.strip()
        if s.startswith("#line"):
            continue
        if re.fullmatch(r'# \d+ ".*".*', s):
            continue
        s = s.replace("\\", "/")
        s = re.sub(r'StaticLocationInfoClass\(\s*\d+\s*,\s*"[^"]*"',
                   'StaticLocationInfoClass(LINE, "FILE"', s)
        s = re.sub(r'"[^"]*/(tree|tree_base)/', '"TREE/', s)
        # XT annotation rows are export metadata (not compiled for web) and carry
        # __LINE__ as a payload; their numeric literals are compared modulo that.
        if ("Annotation<" in s or "FaField_" in s or "kXtTb" in s or "kXtFb" in s):
            s = re.sub(r'\b\d+\b', 'N', s)
        out.append(s)
    # collapse the many blank lines the markers leave behind
    return "\n".join(l for l in out if l)


def pc_parity() -> dict:
    if not VCVARS.is_file():
        raise Blocked(f"MSVC build tools not found: {VCVARS}")
    # The baseline is the same tree with this patch reverted: the scheduler and
    # file overlays stay applied, so the comparison isolates the T-005d patch.
    base = SPIKE / "tree_base"
    if base.exists():
        shutil.rmtree(base)
    p = run(["robocopy", str(TREE), str(base), "/E", "/NFL", "/NDL", "/NJH", "/NJS",
             "/NC", "/NS", "/NP"], LOGS / "copy-base.log")
    if p.returncode > 7:
        raise Failed(f"robocopy (baseline tree) failed ({p.returncode})")
    for rel, _ in PATCHED_FILES:
        dst = base / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_bytes((UP / rel).read_bytes())

    web_only, unconditional, blocked = [], [], []
    for rel, web_only_flag in PATCHED_FILES:
        rc_a, text_a = msvc_preprocess(rel, base, LOGS / f"pp_base_{Path(rel).name}.log")
        rc_b, text_b = msvc_preprocess(rel, TREE, LOGS / f"pp_tree_{Path(rel).name}.log")
        entry = {"file": rel, "webOnly": web_only_flag}
        if rc_a != 0 or rc_b != 0:
            blocked.append({**entry, "reason": "MSVC preprocessing failed",
                            "upstreamRc": rc_a, "treeRc": rc_b})
            continue
        na, nb = normalise_preprocessed(text_a), normalise_preprocessed(text_b)
        if na == nb:
            entry["identical"] = True
            entry["lines"] = len(na.splitlines())
            (web_only if web_only_flag else unconditional).append(entry)
        else:
            if web_only_flag:
                raise Failed(f"PC preprocessed output differs for web-only file {rel}")
            a = na.splitlines()
            b = nb.splitlines()
            diff = [l for l in difflib.unified_diff(a, b, lineterm="", n=0)
                    if l and l[0] in "+-" and not l.startswith(("+++", "---"))]
            entry.update({"identical": False, "changedLines": len(diff),
                          "diffSample": diff[:8]})
            unconditional.append(entry)
    if not web_only:
        raise Failed("no web-only file proved PC parity — the check is not measuring anything")
    return {"webOnlyIdentical": web_only, "unconditionalFixes": unconditional,
            "blocked": blocked,
            "baseline": "the same tree with the T-005d patch reverted (scheduler + file overlays stay applied)",
            "normalisation": ["#line markers",
                              "StaticLocationInfoClass(line, file) -> (LINE, FILE)",
                              "tree/tree_base directory prefix",
                              "XT annotation rows: numeric literals normalised (they carry __LINE__)"],
            "normalisationWhy": ("adding lines necessarily shifts the __LINE__/__FILE__ payload "
                                 "of log statements and of the XT annotation tables; that is "
                                 "where a statement is, not what it does")}


def native_attempt() -> dict:
    """Try a native MSVC build of the same source set and record the blocker."""
    if not VCVARS.is_file():
        return {"status": "blocked", "reason": f"MSVC not found: {VCVARS}"}
    bat = SPIKE / "cl.bat"
    if not bat.is_file():
        bat.write_text(
            "@echo off\n"
            f'call "{VCVARS}" >nul 2>&1\n'
            "if errorlevel 1 ( echo VCVARS-FAIL & exit /b 2 )\n"
            "cl %*\n", encoding="ascii")
    t = TREE / COMMON
    inc = [
        f'-I"{TREE / RP}"', f'-I"{TREE / RP / "include"}"',
        f'-I"{t / "core/include"}"', f'-I"{t / "core"}"',
        f'-I"{t / "system/include"}"', f'-I"{t / "btl/include"}"',
        f'-I"{t / "system"}"', f'-I"{t / "system/source/scheduler"}"',
        f'-I"{t / "misc_shared"}"', f'-I"{t / "misc_shared/include"}"',
        f'-I"{t / "xt2/include"}"',
        f'-I"{TREE / GRAVITY}"', f'-I"{TREE / GRAVITY / "include"}"',
        f'-I"{TREE / "code/mercury/library/graphics/display/include"}"',
        f'-I"{TREE / "code/mercury/library/graphics/display2/include"}"',
    ]
    rel = f"{RP}/source/vehicles/Car/car.cpp"
    cmd = (f'"{bat}" /nologo /c /std:c++14 /EHsc /DBUILD_CONFIG_SPEED /DPLATFORM_PC /DWIN32 '
           f'{" ".join(inc)} /Fo:NUL "{TREE / rel}"')
    p = run(cmd, LOGS / "native-attempt.log", shell=True)
    text = (p.stdout or "") + (p.stderr or "")
    first = [l.strip() for l in text.splitlines() if "error" in l.lower()][:3]
    return {"status": "blocked" if p.returncode else "compiled",
            "file": rel, "rc": p.returncode, "firstErrors": first,
            "note": ("the PC configuration of the racingphysics stdafx reaches the DX11 "
                     "Display layer; the installed checkout has no DirectX SDK headers")}


# ---------------------------------------------------------------------- main


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fresh", action="store_true", help="re-copy upstream first")
    ap.add_argument("--skip-build", action="store_true", help="reuse the last modules")
    ap.add_argument("--make-patch", action="store_true", help="regenerate the committed patch")
    ap.add_argument("--report", default=str(LOGS / "verify-vehicle.json"))
    args = ap.parse_args()

    LOGS.mkdir(parents=True, exist_ok=True)
    OUT.mkdir(parents=True, exist_ok=True)
    SPIKE.mkdir(parents=True, exist_ok=True)
    started = time.time()
    report = {"purpose": "T-005d vehicle physics spike verification",
              "status": "running", "commands": [], "blockers": []}

    if not EM.is_file():
        raise Blocked(f"emsdk em++ missing: {EM}")
    if not NODE.is_file():
        raise Blocked(f"emsdk node missing: {NODE}")
    if not LEVEL.is_file():
        raise Blocked(f"level missing: {LEVEL}")

    if args.make_patch:
        if not TREE.exists():
            raise Blocked("no edited tree; run --fresh first")
        text = make_patch()
        PATCH.write_text(text, encoding="utf-8", newline="\n")
        added = sum(1 for l in text.split("\n") if l.startswith("+") and not l.startswith("+++"))
        removed = sum(1 for l in text.split("\n") if l.startswith("-") and not l.startswith("---"))
        print(f"wrote {PATCH.relative_to(ROOT)}: {len(PATCHED_FILES)} files, "
              f"+{added} -{removed} lines, {len(text)} bytes")
        return 0

    # ---- tree --------------------------------------------------------------
    if args.fresh or not TREE.exists():
        copy_upstream()
        report["tree"] = "fresh copy of upstream"
    else:
        report["tree"] = "reused"
    p = run([sys.executable, str(ROOT / "engine/apply_file_overlay.py"), "--tree", str(TREE)],
            LOGS / "apply-overlays.log")
    report["commands"].append("python engine/apply_file_overlay.py --tree _work/engine-vehicle-spike/tree")
    if p.returncode != 0:
        raise Failed((p.stderr or p.stdout).strip())
    touched = apply_vehicle_patch(TREE)
    report["commands"].append("python engine/verify_vehicle.py  (applies t005d-vehicle-overlay.patch)")
    report["patch"] = {
        "path": str(PATCH.relative_to(ROOT)),
        "bytes": PATCH.stat().st_size,
        "sha256": sha256_file(PATCH),
        "files": touched,
        "webOnlyFiles": [rel for rel, w in PATCHED_FILES if w],
        "unconditionalFiles": [rel for rel, w in PATCHED_FILES if not w],
    }
    if sorted(touched) != sorted(rel for rel, _ in PATCHED_FILES):
        raise Failed(f"the patch touched {touched}, expected {[r for r, _ in PATCHED_FILES]}")

    # ---- car data ----------------------------------------------------------
    xt_bytes = car_xt.extract(GAME)
    xt = car_xt.parse(xt_bytes)
    lines, evidence = car_xt.decode_car(xt, CAR_NAME)
    fields_path = SPIKE / "car.fields"
    fields_path.write_text("".join(f"{k}\t{v}\n" for k, v in lines), encoding="utf-8")
    (SPIKE / "car.evidence.json").write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")
    report["car"] = {
        "source": "gamedata\\xt\\racingphysics.bin (gamedata.pak, codec 2)",
        "xtBytes": len(xt_bytes),
        "xtSha256": sha256_bytes(xt_bytes),
        "record": evidence["record"],
        "fieldLines": len(lines),
        "fieldsSha256": sha256_file(fields_path),
        "physicsParametersHandleId": evidence["physicsParametersHandleId"],
        "physicsParametersResolved": False,
    }
    report["commands"].append(
        "python -c 'car_xt.decode_car(...)'  -> _work/engine-vehicle-spike/car.fields")

    # ---- build -------------------------------------------------------------
    if args.skip_build:
        a_js, b_js = OUT / "vehicle_a.mjs", OUT / "vehicle_b.mjs"
        if not a_js.is_file() or not b_js.is_file():
            raise Blocked("--skip-build but the modules are missing; run without it")
        objects = len(jobs())
    else:
        t0 = time.time()
        a_js, objects = build("a")
        b_js, _ = build("b")
        report["buildSeconds"] = round(time.time() - t0, 1)
    report["commands"] += [
        "em++ <RacingPhysics + Gravity + closure TUs> -O2 -ffp-contract=off -fno-fast-math ... -o vehicle_a.mjs",
        "node engine/harness/t005d-vehicle/run_vehicle_wasm.mjs vehicle_a.mjs Level.levelphysics car.fields run_a.json",
    ]
    wasm_a, wasm_b = a_js.with_suffix(".wasm"), b_js.with_suffix(".wasm")
    hash_a, hash_b = sha256_file(wasm_a), sha256_file(wasm_b)
    report["wasm"] = {
        "buildMode": "reused" if args.skip_build else "fresh",
        "bytes": wasm_a.stat().st_size,
        "sha256": hash_a,
        "rebuildSha256": hash_b,
        "deterministic": hash_a == hash_b,
        "objects": objects,
        "tus": len(jobs()),
        "racingPhysicsTus": len(RP_TUS),
        "gravityTus": len(gravity_tus()),
    }
    if hash_a != hash_b:
        raise Failed(f"the wasm build is not deterministic: {hash_a[:16]} != {hash_b[:16]}")

    # ---- runs --------------------------------------------------------------
    out_a, out_b = SPIKE / "vehicle_a.json", SPIKE / "vehicle_b.json"
    run_harness(a_js, fields_path, out_a)
    run_harness(b_js, fields_path, out_b)
    bytes_a = out_a.read_bytes()
    bytes_b = out_b.read_bytes()
    report["run"] = {
        "documentBytes": len(bytes_a),
        "repeatIdentical": bytes_a == bytes_b,
        "documentSha256": sha256_bytes(bytes_a),
    }
    if bytes_a != bytes_b:
        raise Failed("two runs of the same module produced different documents")
    doc = json.loads(bytes_a.decode("utf-8"))
    report["build"] = doc["build"]
    if doc["build"]["sizeofCarDynamicsXt"] != 636:
        raise Failed(f"sizeof(CarDynamicsXt) is {doc['build']['sizeofCarDynamicsXt']}, expected 636 "
                     "(the 632-byte XT image plus the 4-byte XtHandle difference)")
    # The runtime layout is not the image layout: an XtHandle is 4 bytes on the
    # wire and 8 at runtime (+4 for every struct after it), and the exporter's
    # field order for transmission/gears/tyres differs from carsettings.h, so
    # only the offsets before the first order difference are comparable.
    schema = {t["name"]: t for t in xt["types"]}
    car_schema = schema["RP_CarDynamics"]
    expected = {"name": 0, "mass": 4, "geometry": 64, "torqueCurve": 224}
    off = doc["build"]["offsetof"]
    for key, value in expected.items():
        got = off[key]
        if got != value:
            raise Failed(f"offsetof(CarDynamicsXt,{key}) = {got}, expected {value}")
    report["carOffsets"] = {
        "schemaCarDynamicsSize": car_schema["size"],
        "runtimeSize": doc["build"]["sizeofCarDynamicsXt"],
        "checked": expected,
        "runtimeOffsets": {k: off[k] for k in ("name", "mass", "geometry", "gearRatios",
                                               "tyreGrip", "torqueCurve", "friction")},
        "note": ("XtHandle is 4 bytes on the wire and 8 bytes at runtime (+4 from mass on); "
                 "the exporter's order for transmission/gears/tyres differs from "
                 "carsettings.h, so the last four offsets are not comparable — the decoder "
                 "keys off the schema, never off struct order"),
    }

    report["physics"] = check_document(doc, evidence)

    # ---- explicit scope labels (nothing here is silently degraded) ---------
    report["scope"] = {
        "carBodyShape": "box-from-XT-geometry",
        "carBodyShapeNote": ("VehicleActor builds a composite body from the model's "
                             "collision import; this spike uses a box sized from the XT "
                             "geometry, so body-vs-world contacts are not retail"),
        "surfaceMappingsApplied": False,
        "surfaceMappingsNote": ("RP_SurfaceMappingList is not installed; Surfaces::* "
                                "returns its documented neutral values (grip 1, rolling 0, "
                                "MI 1)"),
        "physicsParametersResolved": False,
        "physicsParametersHandleId": evidence["physicsParametersHandleId"],
        "xtRuntime": False,
        "gravitySolverRuns": True,
        "renderer": False,
        "networkDriven": False,
        "motorbikeClothRopeReplayDriven": False,
        "fixedStepDt": DT,
        "schedulerPolicy": "7,7,7,7,7,7,7,7 (SchedulerConfig.cpp:8)",
        "materialPair": "1x1, friction 0.65, restitution 0.05 (Materials.cpp:35-42)",
        "startPoint": {"x": START_X, "z": START_Z,
                       "source": "collision-oracle fixture ray-random-21 contact x/z"},
    }

    # ---- PC parity ---------------------------------------------------------
    report["pcParity"] = pc_parity()

    # ---- native attempt ----------------------------------------------------
    report["nativeParity"] = native_attempt()
    report["nativeParity"]["wasmDeterminism"] = {
        "buildSha256": hash_a,
        "rebuildSha256": hash_b,
        "runDocumentSha256": report["run"]["documentSha256"],
        "twoRunsByteIdentical": report["run"]["repeatIdentical"],
    }

    report["elapsedSeconds"] = round(time.time() - started, 1)
    report["status"] = "PASS"

    report_path = Path(args.report)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

    print(f"tree            {TREE}")
    print(f"patch           {PATCH.name} {report['patch']['bytes']} B sha256={report['patch']['sha256'][:16]}")
    print(f"car             {CAR_NAME} record {report['car']['record']['index']} "
          f"({report['car']['record']['id']}), {report['car']['fieldLines']} fields")
    print(f"wasm            {report['wasm']['bytes']} B {hash_a[:16]} "
          f"({report['wasm']['objects']} objects: {report['wasm']['racingPhysicsTus']} RP + "
          f"{report['wasm']['gravityTus']} Gravity + closure)")
    print(f"deterministic   build={report['wasm']['deterministic']} run={report['run']['repeatIdentical']}")
    ph = report["physics"]
    print(f"physics         ticks={ph['ticks']} contacts={ph['contactTicks']} nan={ph['nanTicks']} "
          f"settleMax={ph['maxSettleSpeedMps']} m/s")
    print(f"                speed {ph['speedAtThrottleStartMps']} -> {ph['finalSpeedMps']} m/s, "
          f"best {ph['bestSpeedMps']} m/s, distance {ph['driveDistanceM']} m")
    print(f"allStateHash    {ph['allStateHash']}")
    print(f"pc parity       {len(report['pcParity']['webOnlyIdentical'])} web-only files identical, "
          f"{len(report['pcParity']['unconditionalFixes'])} unconditional fixes, "
          f"{len(report['pcParity']['blocked'])} blocked")
    print(f"native parity   {report['nativeParity']['status']}: "
          f"{(report['nativeParity'].get('firstErrors') or [''])[0][:110]}")
    print(f"status          {report['status']}")
    print(f"report          {report_path}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Blocked as exc:
        print(f"verify_vehicle: BLOCKED: {exc}", file=sys.stderr)
        raise SystemExit(3)
    except Failed as exc:
        print(f"verify_vehicle: FAILED: {exc}", file=sys.stderr)
        raise SystemExit(2)
