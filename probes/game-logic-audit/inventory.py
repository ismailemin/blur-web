#!/usr/bin/env python3
"""Deterministic inventory of the upstream race/game-logic modules.

Read-only: every path is opened for reading inside upstream/BlurRebuilt.
Output: _work/game-logic-audit/game-logic-inventory.json

Classification is deliberately conservative:

  portable     -- a real TU compiled in this audit with the existing web
                  platform headers (not linked, not exercised).
  reimplement  -- behaviour is understood from source, but the code is bound to
                  the actor/game/XT/UI runtime; the rules layer is rebuilt in JS.
  platform-bound -- the module's primary job is DirectX, Windows, DemonWare,
                  RacerNet, Luau/UI, audio, save/profile or platform services.
  unknown      -- source is readable but the value/data contract is not decoded;
                  no behaviour is claimed.

The JSON is sorted and contains no timestamps. Run verify_inventory.py to
recompute every field and the canonical SHA-256.
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
UPSTREAM = ROOT / "upstream" / "BlurRebuilt"
OUT = ROOT / "_work" / "game-logic-audit" / "game-logic-inventory.json"

# Only race-relevant trees. Additions must be justified in the analysis doc.
SUBSYSTEMS = [
    ("race_logic_core", "code/amax/game/GameLogic/RaceLogicCore", None),
    ("race_modes", "code/amax/game/GameLogic/RaceModes", None),
    ("race_rules", "code/amax/game/GameLogic/RaceRules", None),
    ("game_modes", "code/amax/game/GameLogic/GameModes", None),
    ("pickups", "code/amax/game/GameLogic/Pickups", None),
    ("single_player", "code/amax/game/GameLogic/SinglePlayer", None),
    (
        "structures",
        "code/amax/game/GameLogic/Structures",
        {
            "LevelResult", "RaceStatistics", "VehicleRaceStatistics", "MpResults",
            "NetVehicleData", "NetTeamData", "LevelState", "LevelStateConstants",
            "LevelStateVehiclePickupInfo",
        },
    ),
    (
        "game_data",
        "code/amax/game/GameLogic/GameData",
        {"GameEventData", "GameData", "MultiplayerData", "GameVehicleData"},
    ),
    ("play_mode", "code/amax/game/GameLogic/PlayMode", None),
    ("vehicle_logic", "code/amax/game/Game/GameActors/Components/VehicleLogic", None),
    ("ai_glue", "code/amax/game/AI", None),
    ("ai_core", "code/mercury/library/ai/air", None),
    (
        "race_actors",
        "code/amax/game/GameLogic/ActorStudioActors",
        {
            "TrafficActor", "SplitLineActor", "StartPositionActor",
            "StartLineInfoActor", "PickupPositionActor",
            "PickupPositionActorDecoy",
        },
    ),
]

EXTS = {".cpp", ".h", ".hpp", ".inl"}

# Lexical dependency indicators. These are evidence of coupling in the source,
# not proof of a compiled/linked dependency.
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

CLASS_RE = re.compile(r"\b(?:class|struct)\s+([A-Za-z_]\w*)")

# RaceModeMultiplayer and its children are network modes. Match by stem.
NETWORK_MODE_STEMS = (
    "RaceModeMultiplayer",
    "RaceModeFriendDemand",
)
NETWORK_GAME_STEMS = ("GameModeNetwork", "GameModeOnline", "GameModeSystemLink")


def rel(path: Path) -> str:
    return path.relative_to(UPSTREAM).as_posix()


def line_count(data: bytes) -> int:
    if not data:
        return 0
    return data.count(b"\n") + (0 if data.endswith(b"\n") else 1)


def subsystem_for(path: Path) -> str | None:
    r = rel(path)
    for name, prefix, whitelist in SUBSYSTEMS:
        if r == prefix or r.startswith(prefix + "/"):
            if whitelist is not None and path.stem not in whitelist:
                return None
            return name
    return None


def classify(subsystem: str, path: Path, text: str) -> str:
    stem = path.stem
    if subsystem == "ai_core":
        return "portable"
    if subsystem == "game_data":
        return "unknown"
    if subsystem == "race_modes" and any(stem.startswith(s) for s in NETWORK_MODE_STEMS):
        return "platform-bound"
    if subsystem == "game_modes" and any(stem.startswith(s) for s in NETWORK_GAME_STEMS):
        return "platform-bound"
    if subsystem == "single_player":
        return "platform-bound"
    if "Display/Core/Includes.h" in text or "<Display.h>" in text:
        return "platform-bound"
    return "reimplement"


def flags_for(text: str) -> dict[str, bool]:
    return {name: any(rx.search(text) for rx in rxs) for name, rxs in DEP_RE.items()}


def git_head() -> str:
    try:
        return subprocess.check_output(
            ["git", "-C", str(UPSTREAM), "rev-parse", "HEAD"], text=True
        ).strip()
    except Exception:
        return "unknown"


def main() -> int:
    global OUT
    if "--out" in sys.argv:
        OUT = Path(sys.argv[sys.argv.index("--out") + 1]).resolve()
    files = []
    for path in sorted(UPSTREAM.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in EXTS:
            continue
        sub = subsystem_for(path)
        if sub is None:
            continue
        raw = path.read_bytes()
        text = raw.decode("utf-8", errors="replace")
        classes = sorted(set(CLASS_RE.findall(text)))
        files.append(
            {
                "path": rel(path),
                "subsystem": sub,
                "bytes": len(raw),
                "lines": line_count(raw),
                "classes": classes,
                "classCount": len(classes),
                "classification": classify(sub, path, text),
                "dependencies": flags_for(text),
                "compiledInExistingWasm": False,
                "compiledInAuditProbe": False,  # filled by compile probe if run
            }
        )

    # Merge the optional compile-probe result if it exists, but only for ai_core.
    files.sort(key=lambda f: f["path"])
    probe_path = ROOT / "_work" / "game-logic-audit" / "ai-compile-probe.json"
    if probe_path.exists():
        probe = json.loads(probe_path.read_text(encoding="utf-8"))
        ok = {
            "code/mercury/library/ai/air/source/" + e["tu"]
            for e in probe.get("tus", [])
            if e.get("compiled")
        }
        for f in files:
            if f["path"] in ok:
                f["compiledInAuditProbe"] = True

    by_class: dict[str, dict[str, int]] = {}
    by_sub: dict[str, dict[str, int]] = {}
    dep_counts: dict[str, int] = {k: 0 for k in DEP_TOKENS}
    for f in files:
        for bucket, key in ((by_class, f["classification"]), (by_sub, f["subsystem"])):
            b = bucket.setdefault(key, {"files": 0, "lines": 0, "classes": 0})
            b["files"] += 1
            b["lines"] += f["lines"]
            b["classes"] += f["classCount"]
        for k, v in f["dependencies"].items():
            if v:
                dep_counts[k] += 1

    payload = {
        "schema": "blur-web.game-logic-inventory.v1",
        "scope": "upstream race/game-logic modules available for a full race",
        "source": {
            "repository": "upstream/BlurRebuilt",
            "commit": git_head(),
            "readOnly": True,
            "extensions": sorted(EXTS),
        },
        "classificationLegend": {
            "portable": "real TU compiled in this audit with the existing web platform headers; not linked or exercised",
            "reimplement": "behaviour understood from source, but bound to actor/game/XT/UI runtime; rebuilt in the original JS rules layer",
            "platform-bound": "primary job is DirectX, Windows, DemonWare/RacerNet, UI/Luau, audio, save/profile or platform services",
            "unknown": "source readable but value/data contract not decoded; no behaviour claimed",
        },
        "dependencyLegend": "lexical indicators in source; evidence of coupling, not proof of linkage",
        "counts": {
            "files": len(files),
            "lines": sum(f["lines"] for f in files),
            "classes": sum(f["classCount"] for f in files),
            "byClassification": by_class,
            "bySubsystem": by_sub,
            "filesWithDependency": dep_counts,
            "existingWasmClosureGameLogicFiles": sum(
                1 for f in files if f["compiledInExistingWasm"]
            ),
            "auditProbeCompiledFiles": sum(
                1 for f in files if f["compiledInAuditProbe"]
            ),
        },
        "limits": [
            "This inventory is not a full-game coverage claim.",
            "Line counts include comments and blank lines.",
            "Class counts are lexical class/struct declarations, including forward declarations.",
            "Dependency flags are token indicators, not proof that a symbol is linked.",
            "portable means compiled as an object in this audit, not linked, run or verified numerically.",
            "No retail tuning value is recovered by this file.",
        ],
        "files": files,
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    print(f"wrote {OUT}")
    print(
        "files={files} lines={lines} classes={classes}".format(**payload["counts"])
    )
    for k in sorted(by_class):
        b = by_class[k]
        print(f"  {k:15s} files={b['files']:4d} lines={b['lines']:7d}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
