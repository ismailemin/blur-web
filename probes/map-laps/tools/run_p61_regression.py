#!/usr/bin/env python3
"""Run the committed P61 (River lap-search) verifier as a regression, without
touching any `probes/lap-search` or `_work/lap-search` file.

`probes/lap-search/tools/verify_loops.py` is imported unmodified; only its module
level `OUT` constant (the output directory) is redirected into this probe's
`_work/map-laps/p61-regression/` so the committed `_work/lap-search/verify.json`
is not overwritten. Every `_work/lap-search` artifact is hashed before and after
the run and the run fails if any byte changed.

    python probes/map-laps/tools/run_p61_regression.py
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
P61_DIR = ROOT / "probes/lap-search/tools"
P61_ARTIFACTS = ROOT / "_work/lap-search"
OUT = ROOT / "_work/map-laps/p61-regression"
EXPECTED_LOOPS_HASH = ("sha256:acc47b6bbd0719af857323060b273e83e933bf7b86330d0362b3e70409873536")
EXPECTED_FILE_SHA = "2aabf0cd04fc96b2e2cf903a392fc86fc5b2cd6e85772b9d0e8b523a0826a59c"
EXPECTED_CHECKS = 34


def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def snapshot() -> dict:
    return {p.name: sha(p) for p in sorted(P61_ARTIFACTS.iterdir()) if p.is_file()}


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    before = snapshot()
    loops = P61_ARTIFACTS / "loops.json"
    file_sha = sha(loops)
    doc = json.loads(loops.read_text(encoding="utf-8"))
    problems = []
    if file_sha != EXPECTED_FILE_SHA:
        problems.append("loops.json file sha %s != %s" % (file_sha, EXPECTED_FILE_SHA))
    if doc.get("hash") != EXPECTED_LOOPS_HASH:
        problems.append("loops.json canonical hash %s != %s"
                        % (doc.get("hash"), EXPECTED_LOOPS_HASH))

    spec = importlib.util.spec_from_file_location("p61_verify_loops",
                                                  P61_DIR / "verify_loops.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    mod.OUT = OUT
    # The verifier reads loops.json from its OUT directory. Copy the committed
    # artifact in (read-only source, byte-identical) and let the verifier check
    # its own canonical hash against the copy.
    (OUT / "loops.json").write_bytes(loops.read_bytes())
    if sha(OUT / "loops.json") != EXPECTED_FILE_SHA:
        problems.append("copied loops.json is not byte-identical to the committed one")
    rc = mod.main()

    after = snapshot()
    if before != after:
        problems.append("a _work/lap-search artifact changed during the run")

    verify = json.loads((OUT / "verify.json").read_text(encoding="utf-8"))
    n_checks = (1 + len(verify["loops"]) * 9 + len(verify["barriers"]) + 3)
    if not verify["pass"]:
        problems.append("P61 verify.json is not a pass: %s" % verify["failures"])
    if n_checks != EXPECTED_CHECKS:
        problems.append("check count %d != %d" % (n_checks, EXPECTED_CHECKS))

    result = dict(
        kind="map-laps.p61-regression",
        version=1,
        **{"pass": not problems and rc == 0},
        problems=problems,
        p61LoopsFileSha256=file_sha,
        p61LoopsCanonicalHash=doc.get("hash"),
        checks=n_checks,
        loops=[dict(id=q["id"], length=q["metrics"]["length"],
                    maxStep=q["metrics"]["maxStep"],
                    minBandWidth=q["metrics"]["minBandWidth"])
               for q in verify["loops"]],
        barriers=len(verify["barriers"]),
        artifactsUntouched=before == after,
        redirectNote=("verify_loops.py OUT redirected to _work/map-laps/p61-regression; "
                      "no probes/lap-search or _work/lap-search file is written"),
        verifyHash=verify["hash"],
    )
    body = json.dumps(result, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    result["hash"] = "sha256:" + hashlib.sha256(body.encode("utf-8")).hexdigest()
    (OUT / "regression.json").write_text(json.dumps(result, indent=1) + "\n", encoding="utf-8")
    print(json.dumps(result, indent=1))
    return 0 if result["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
