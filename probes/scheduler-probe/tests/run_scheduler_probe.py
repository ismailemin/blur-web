#!/usr/bin/env python3
"""Build and verify the T-005c fixed-step scheduler probe.

Runs four independent artefacts and compares them:
  1. native MSVC /W4 build (probe + unit tests + CTest)
  2. wasm32 build from the pinned emsdk, executed in node
  3. independent Python model of the same rule
  4. a second native run, to prove bitwise determinism

This script never touches tools/verify_asset_probe.py; the main agent wires the
final suite step.

Usage:
    python probes/scheduler-probe/tests/run_scheduler_probe.py
    python probes/scheduler-probe/tests/run_scheduler_probe.py --skip-build
    python probes/scheduler-probe/tests/run_scheduler_probe.py --native-only
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
PROBE = ROOT / "probes" / "scheduler-probe"
TESTS = PROBE / "tests"
WORK = ROOT / "_work" / "scheduler-probe"
LOGS = WORK / "logs"
BUILD = WORK / "build"
CSV = WORK / "csv"
NATIVE_BUILD = ROOT / "_work" / "build" / "scheduler-probe-native"
EMSDK = ROOT / "_work" / "toolchains" / "emsdk"

NATIVE_FLAGS = "/W4 /permissive- /fp:precise"
WASM_FLAGS = "-O2 -fno-fast-math -ffp-contract=off"
WASM_SOURCES = [
    PROBE / "src" / "fixed_step.cpp",
    PROBE / "src" / "sim_state.cpp",
    PROBE / "src" / "scenarios.cpp",
    PROBE / "src" / "wasm_entry.cpp",
]


def relative(path: Path) -> str:
    return path.resolve().relative_to(ROOT).as_posix()


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def cmake_path() -> Path:
    query = Path(os.environ.get("ProgramFiles(x86)", "C:/Program Files (x86)")) / (
        "Microsoft Visual Studio/Installer/vswhere.exe")
    location = subprocess.check_output(
        [str(query), "-latest", "-products", "*", "-requires",
         "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"],
        text=True).strip()
    if not location:
        raise RuntimeError("Visual Studio C++ build tools not found")
    return Path(location) / "Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe"


class Runner:
    def __init__(self) -> None:
        self.checks: list[dict] = []
        self.commands: list[dict] = []

    def step(self, name: str, argv: list[str]) -> int:
        LOGS.mkdir(parents=True, exist_ok=True)
        log = LOGS / f"{name}.log"
        rendered = " ".join(f'"{item}"' if " " in item else item for item in argv)
        with log.open("w", encoding="utf-8") as stream:
            stream.write(f"# {rendered}\n")
            stream.flush()
            completed = subprocess.run(argv, cwd=ROOT, stdout=stream,
                                       stderr=subprocess.STDOUT)
        self.commands.append({"step": name, "exitCode": completed.returncode,
                              "command": rendered, "log": relative(log)})
        ok = completed.returncode == 0
        self.checks.append({"name": f"step:{name}", "ok": ok,
                            "detail": f"exit {completed.returncode}; log {relative(log)}"})
        if not ok:
            tail = log.read_text(encoding="utf-8", errors="replace")[-4000:]
            print(f"\n{name}: FAIL (exit {completed.returncode})\n{tail}", file=sys.stderr)
        else:
            print(f"{name}: PASS", flush=True)
        return completed.returncode

    def check(self, name: str, ok: bool, detail: str) -> None:
        self.checks.append({"name": name, "ok": bool(ok), "detail": detail})
        print(f"{name}: {'PASS' if ok else 'FAIL'}", flush=True)
        if not ok:
            print(f"  {detail}", file=sys.stderr)


def diff_values(left, right, path: str = "") -> list[str]:
    differences: list[str] = []
    if isinstance(left, dict) and isinstance(right, dict):
        for key in sorted(set(left) | set(right)):
            child = f"{path}.{key}" if path else str(key)
            if not path and key == "build":
                continue
            if key not in left or key not in right:
                differences.append(f"{child}: missing on one side")
            else:
                differences.extend(diff_values(left[key], right[key], child))
    elif isinstance(left, list) and isinstance(right, list):
        if len(left) != len(right):
            differences.append(f"{path}: length {len(left)} vs {len(right)}")
        else:
            for index, (a, b) in enumerate(zip(left, right)):
                differences.extend(diff_values(a, b, f"{path}[{index}]"))
    else:
        if left != right:
            differences.append(f"{path}: {left!r} vs {right!r}")
    return differences


def scenario(document: dict, name: str) -> dict | None:
    for item in document.get("scenarios", []):
        if item.get("name") == name:
            return item
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-build", action="store_true",
                        help="reuse the existing native and wasm artefacts")
    parser.add_argument("--native-only", action="store_true",
                        help="skip the wasm32 build and node comparison")
    args = parser.parse_args()

    WORK.mkdir(parents=True, exist_ok=True)
    runner = Runner()

    native_exe = NATIVE_BUILD / "Release" / "scheduler_probe.exe"
    wasm_module = BUILD / "scheduler_probe.mjs"
    wasm_exe = EMSDK / "upstream" / "emscripten" / "em++.py"
    node_verify = TESTS / "verify_scheduler_wasm.mjs"

    if not args.skip_build:
        cmake = cmake_path()
        if runner.step("configure-native", [str(cmake), "-S", str(PROBE), "-B",
                                            str(NATIVE_BUILD), "-G", "Visual Studio 17 2022",
                                            "-A", "x64"]) != 0:
            return 1
        if runner.step("build-native", [str(cmake), "--build", str(NATIVE_BUILD),
                                        "--config", "Release"]) != 0:
            return 1
        ctest = cmake.with_name("ctest.exe")
        if runner.step("ctest", [str(ctest), "--test-dir", str(NATIVE_BUILD), "-C",
                                 "Release", "--output-on-failure"]) != 0:
            return 1

        if not args.native_only:
            if not wasm_exe.exists():
                runner.check("wasm-toolchain", False, f"pinned emsdk not found at {wasm_exe}")
                return 1
            BUILD.mkdir(parents=True, exist_ok=True)
            wasm_command = [sys.executable, str(wasm_exe)]
            wasm_command += [str(source) for source in WASM_SOURCES]
            wasm_command += [
                "-std=c++17", *WASM_FLAGS.split(),
                f'-DPROBE_FLAGS_STRING="{WASM_FLAGS}"',
                "-sMODULARIZE=1", "-sEXPORT_ES6=1", "-sENVIRONMENT=node,web",
                "-sALLOW_MEMORY_GROWTH=0", "-sINITIAL_MEMORY=16777216",
                "-sMAXIMUM_MEMORY=268435456", "--no-entry",
                "-sEXPORTED_FUNCTIONS=_sched_probe_json,_sched_probe_selftest",
                "-sEXPORTED_RUNTIME_METHODS=UTF8ToString",
                "-o", str(wasm_module),
            ]
            if runner.step("build-wasm", wasm_command) != 0:
                return 1

    if not native_exe.exists():
        runner.check("native-artefact", False, f"missing {native_exe}; run without --skip-build")
        return 1

    native_json = WORK / "native.json"
    repeat_json = WORK / "native-repeat.json"
    if runner.step("run-native", [str(native_exe), "--out", str(native_json),
                                  "--csv", str(CSV), "--quiet"]) != 0:
        return 1
    if runner.step("run-native-selftest", [str(native_exe), "--selftest"]) != 0:
        return 1
    if runner.step("run-native-repeat", [str(native_exe), "--out", str(repeat_json),
                                         "--quiet"]) != 0:
        return 1

    reference_json = WORK / "reference.json"
    if runner.step("run-reference", [sys.executable, str(TESTS / "reference_scheduler.py"),
                                     "--out", str(reference_json)]) != 0:
        return 1

    wasm_present = False
    if not args.native_only:
        if not wasm_module.exists():
            # Never silently skip the wasm leg: a missing artefact is a failure.
            runner.check("wasm-artefact", False,
                         f"missing {wasm_module}; run without --skip-build")
        elif runner.step("run-wasm", ["node", str(node_verify), str(wasm_module),
                                      str(WORK / "wasm.json")]) == 0:
            wasm_present = True
        else:
            return 1

    native_doc = json.loads(native_json.read_text(encoding="utf-8"))
    reference_doc = json.loads(reference_json.read_text(encoding="utf-8"))

    runner.check("determinism-native", native_json.read_bytes() == repeat_json.read_bytes(),
                 "two native runs are byte-identical")

    differences = diff_values(native_doc, reference_doc)
    runner.check("native-vs-python", not differences,
                 f"{len(differences)} differences: " + "; ".join(differences[:8]))

    if native_doc.get("build", {}).get("target", "").startswith("native"):
        runner.check("build-target-native", True, native_doc["build"]["target"])
    else:
        runner.check("build-target-native", False, str(native_doc.get("build")))

    if wasm_present:
        wasm_doc = json.loads((WORK / "wasm.json").read_text(encoding="utf-8"))
        wasm_differences = diff_values(native_doc, wasm_doc)
        runner.check("native-vs-wasm", not wasm_differences,
                     f"{len(wasm_differences)} differences: " + "; ".join(wasm_differences[:8]))
        runner.check("build-target-wasm", wasm_doc.get("build", {}).get("target") == "wasm32",
                     str(wasm_doc.get("build")))

    # A6: identical simulated state for the same duration at three cadences.
    trio = ["equal5s-600f", "equal5s-150f", "equal5s-100f"]
    resolved = [scenario(native_doc, name) for name in trio]
    if any(item is None for item in resolved):
        runner.check("frame-rate-independence", False, "equal5s scenarios missing")
    else:
        ticks = {item["totalTicks"] for item in resolved}
        hashes = {item["state"]["hash"] for item in resolved}
        alphas = {item["finalAlphaBits"] for item in resolved}
        runner.check("frame-rate-independence",
                     ticks == {300} and len(hashes) == 1 and len(alphas) == 1,
                     f"ticks={sorted(ticks)} hashes={sorted(hashes)} alphas={sorted(alphas)}")

    # The 4-tick cap must be visibly enforced, and its cost accounted for.
    boundary = scenario(native_doc, "capboundary-15hz-75f")
    runner.check("cap-boundary-accounting",
                 boundary is not None and
                 boundary["totalTicks"] + boundary["backlogDropTicks"] ==
                 boundary["totalRequestedTicks"],
                 "executed ticks + clamped ticks == requested ticks")

    # Cap and pause evidence, checked on the native document.
    hitch = scenario(native_doc, "hitch-250ms-400f")
    gap = scenario(native_doc, "tabgap-5s-400f")
    runner.check("cap-enforcement",
                 hitch is not None and hitch["cappedFrames"] == 1 and
                 hitch["maxTicksInFrame"] == 4,
                 f"hitch={None if hitch is None else (hitch['cappedFrames'], hitch['maxTicksInFrame'])}")
    runner.check("pause-rule",
                 gap is not None and gap["pausedFrames"] == 1 and
                 gap["frameAccUnits"][200] == 0,
                 f"gap={None if gap is None else (gap['pausedFrames'], gap['frameAccUnits'][200])}")

    runner.check("alpha-bounds", native_doc.get("checks", {}).get("alphaInRange") is True,
                 str(native_doc.get("checks")))
    runner.check("accumulator-bounds",
                 native_doc.get("checks", {}).get("accumulatorInRange") is True,
                 str(native_doc.get("checks")))
    runner.check("cap-bounds", native_doc.get("checks", {}).get("capRespected") is True,
                 str(native_doc.get("checks")))

    artifacts = {"native.json": native_json, "reference.json": reference_json}
    if wasm_present:
        artifacts["wasm.json"] = WORK / "wasm.json"
    artifact_hashes = {name: sha256(path) for name, path in artifacts.items()}

    failed = [check for check in runner.checks if not check["ok"]]
    summary = {
        "utc": datetime.now(timezone.utc).isoformat(),
        "probe": "t005c-fixed-step",
        "scope": "standalone driver probe; no engine integration is claimed",
        "checks": runner.checks,
        "commands": runner.commands,
        "artifacts": artifact_hashes,
        "scenarioHashes": {
            item["name"]: {"ticks": item["totalTicks"],
                           "state": item["state"]["hash"],
                           "render": item["render"]["hash"]}
            for item in native_doc.get("scenarios", [])
        },
        "passed": not failed,
    }
    (WORK / "summary.json").write_text(json.dumps(summary, indent=2) + "\n",
                                       encoding="utf-8")

    print(f"\n{len(runner.checks) - len(failed)}/{len(runner.checks)} checks passed")
    print(f"summary: {relative(WORK / 'summary.json')}")
    return 0 if not failed else 1


if __name__ == "__main__":
    raise SystemExit(main())
