#!/usr/bin/env python3
"""Verify the game-logic inventory against the read-only upstream tree.

Checks:
  * inventory.py is deterministic (re-run into _work and compare bytes);
  * every path stays inside upstream/BlurRebuilt and exists with the same size;
  * line counts, class counts and dependency totals recompute;
  * classification bins and subsystem totals equal the file rows;
  * no game-logic TU appears in the existing wasm object closure;
  * upstream/BlurRebuilt git status is clean.

Exit 0 = PASS. Prints the canonical SHA-256 of the inventory file.
"""
from __future__ import annotations

import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
UPSTREAM = ROOT / "upstream" / "BlurRebuilt"
INV = ROOT / "_work" / "game-logic-audit" / "game-logic-inventory.json"
RERUN = ROOT / "_work" / "game-logic-audit" / "_verify-inventory.json"
PROBE = ROOT / "_work" / "game-logic-audit" / "ai-compile-probe.json"
CLASS_RE = re.compile(r"\b(?:class|struct)\s+([A-Za-z_]\w*)")
DEP_TOKENS = {
    "scheduler": [r"\bScheduler::", r"\bJobQueue\b", r"\bjobqueue\b"],
    "physics": [r"\bRacingPhysics\b", r"\bGravity::", r"\bC_Body\b", r"\bPhysicsScene\b"],
    "xt": [r"\bXtHandle\b", r"\bXT_TYPE\b", r"\bSorcery\b", r"<xt/"],
    "audio": [r"\bAudio::", r"\bGameAudio\b", r"\bPlaySound\b", r"\bSoundEffect"],
    "network": [r"\bRacerNet\b", r"\bNetMessage\b", r"\bDemonWare\b", r"\bWinSock\b", r"<Network/"],
    "ui_lua": [r"\blua_", r"\bUI::", r"<ui/", r"<Ui/", r"\bC_WideString"],
    "render_dx": [r"\bDisplay2?\b", r"\bD3D1?1\b", r"\bWorldRender\b", r"\bSceneGraph\b"],
    "actor_system": [r"\bActor::", r"\bC_GameActor\b", r"<actor_system/"],
    "filesystem": [r"\bI_FileSystem\b", r"\bI_File\b", r"\bC_File\b"],
    "input": [r"\bInput::", r"\bGameControls\b", r"\bE_Button_"],
    "windows": [r"<windows\.h>", r"<winsock2\.h>", r"\bWin32\b", r"\bPLATFORM_PC\b"],
    "ps3": [r"<cell/", r"\bPLATFORM_PS3\b"],
    "save_profile": [r"\bC_GameProfile\b", r"\bSP_SaveGame\b", r"\bAchievements\b"],
    "collision": [r"\bCollision::", r"\bDoRayTrace\b", r"\bC_CollisionBody\b"],
}
DEP_RE = {k: [re.compile(p) for p in v] for k, v in DEP_TOKENS.items()}
GAME_STEMS = re.compile(
    r"^(RaceLogicCore|RaceMode|RaceRule|GameMode|PickupsManager|PickupBase|"
    r"VLC_Damage|VLC_NewScoring|VLC_Scoring|VLC_Statistics|VLC_Pickups|"
    r"TrafficActor|SplitLineActor|StartPositionActor|StartLineInfoActor|"
    r"RLTrackPositionController|RLScoringController|RLLapSplitTimeController|"
    r"AI_Amax|CRaceDirector|cRaceDirector|CRubberbandingAI|CSplineFollower)"
)


def fail(msg: str, errors: list[str]) -> None:
    errors.append(msg)
    print("FAIL " + msg)


def main() -> int:
    errors: list[str] = []
    data = json.loads(INV.read_text(encoding="utf-8"))

    # 1. Deterministic re-run.
    p = subprocess.run(
        [sys.executable, str(ROOT / "probes" / "game-logic-audit" / "inventory.py"),
         "--out", str(RERUN)],
        capture_output=True, text=True, cwd=str(ROOT),
    )
    if p.returncode != 0:
        fail(f"inventory rerun failed: {p.stderr[-400:]}", errors)
    elif RERUN.read_bytes() != INV.read_bytes():
        fail("inventory is not deterministic (rerun differs)", errors)
    else:
        print("PASS deterministic rerun")

    files = data.get("files", [])
    paths = [f["path"] for f in files]
    if paths != sorted(paths):
        fail("file rows are not sorted", errors)
    if len(paths) != len(set(paths)):
        fail("duplicate file rows", errors)

    recomputed = {}
    for f in files:
        path = (UPSTREAM / f["path"]).resolve()
        try:
            path.relative_to(UPSTREAM.resolve())
        except ValueError:
            fail(f"path escapes upstream: {f['path']}", errors)
            continue
        if not path.exists():
            fail(f"missing: {f['path']}", errors)
            continue
        raw = path.read_bytes()
        lines = 0 if not raw else raw.count(b"\n") + (0 if raw.endswith(b"\n") else 1)
        if len(raw) != f["bytes"]:
            fail(f"bytes mismatch: {f['path']}", errors)
        if lines != f["lines"]:
            fail(f"lines mismatch: {f['path']}", errors)
        text = raw.decode("utf-8", errors="replace")
        classes = len(set(CLASS_RE.findall(text)))
        if classes != f["classCount"]:
            fail(f"class count mismatch: {f['path']} {classes}!={f['classCount']}", errors)
        recomputed[f["path"]] = (lines, classes, raw)

    # 2. Totals.
    counts = data.get("counts", {})
    if counts.get("files") != len(files):
        fail("file total mismatch", errors)
    if counts.get("lines") != sum(f["lines"] for f in files):
        fail("line total mismatch", errors)
    if counts.get("classes") != sum(f["classCount"] for f in files):
        fail("class total mismatch", errors)
    for bucket, key in (("byClassification", "classification"), ("bySubsystem", "subsystem")):
        b = counts.get(bucket, {})
        if sum(v["files"] for v in b.values()) != len(files):
            fail(f"{bucket} file totals mismatch", errors)
        if sum(v["lines"] for v in b.values()) != counts.get("lines"):
            fail(f"{bucket} line totals mismatch", errors)
        for name, v in b.items():
            rows = [f for f in files if f[key] == name]
            if v["files"] != len(rows) or v["lines"] != sum(r["lines"] for r in rows):
                fail(f"{bucket}[{name}] mismatch", errors)

    # 3. Dependency totals.
    for name in DEP_TOKENS:
        n = sum(1 for f in files if f["dependencies"].get(name))
        if counts.get("filesWithDependency", {}).get(name) != n:
            fail(f"dependency total mismatch: {name}", errors)

    # 4. Existing wasm closure must not contain game-logic TUs.
    if counts.get("existingWasmClosureGameLogicFiles") != 0:
        fail("inventory claims game logic in existing wasm closure", errors)
    for f in files:
        if f["compiledInExistingWasm"]:
            fail(f"claims existing wasm compile: {f['path']}", errors)
    hits = []
    for obj in (ROOT / "_work").rglob("*.o"):
        if GAME_STEMS.match(obj.stem.split("_", 1)[-1]):
            hits.append(obj.relative_to(ROOT).as_posix())
    if hits:
        fail("game-logic object found in _work: " + ", ".join(sorted(hits)[:5]), errors)
    else:
        print("PASS no game-logic object in existing wasm closure")

    # 5. Optional AI compile probe agreement.
    if PROBE.exists():
        probe = json.loads(PROBE.read_text(encoding="utf-8"))
        compiled = sum(1 for e in probe.get("tus", []) if e.get("compiled"))
        if counts.get("auditProbeCompiledFiles") != compiled:
            fail("ai compile-probe count disagrees with inventory", errors)
        print(f"PASS ai compile probe {compiled}/{len(probe.get('tus', []))}")

    # 6. Upstream clean.
    status = subprocess.check_output(
        ["git", "-C", str(UPSTREAM), "status", "--porcelain"], text=True
    ).strip()
    if status:
        fail("upstream checkout is dirty", errors)
    else:
        print("PASS upstream checkout clean")

    sha = hashlib.sha256(INV.read_bytes()).hexdigest()
    print(f"inventory sha256 {sha}")
    print("PASS" if not errors else f"FAIL ({len(errors)} errors)")
    return 0 if not errors else 1


if __name__ == "__main__":
    sys.exit(main())
