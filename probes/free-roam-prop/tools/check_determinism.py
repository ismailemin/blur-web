#!/usr/bin/env python
"""Two-run determinism check for the P68a free-roam prop build.

  python check_determinism.py              # committed P66 manifest chain
  python check_determinism.py --extended   # free-roam-r04 manifest chain

Base chain: build_props.py twice + resolve_r04.mjs twice.
Extended chain: build_colliders_r04.mjs twice, build_props.py --manifest
colliders-r04.json --out extended twice, resolve_r04.mjs twice.

Writes <out>/determinism.json (and _work/free-roam-prop/determinism-extended.json
for the extended chain).
"""

import hashlib
import json
import subprocess
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
TOP = ROOT / "_work/free-roam-prop"
NODE = ROOT / "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"
EXTENDED = "--extended" in sys.argv[1:]
OUT = TOP / "extended" if EXTENDED else TOP
MANIFEST = TOP / "colliders-r04.json" if EXTENDED else ROOT / "_work/prop-collision/colliders.json"


def sha256_bytes(b):
    return hashlib.sha256(b).hexdigest()


def array_hash(key, a):
    a = np.ascontiguousarray(a)
    h = hashlib.sha256()
    h.update(key.encode("ascii"))
    h.update(str(a.dtype).encode("ascii"))
    h.update(str(a.shape).encode("ascii"))
    h.update(a.tobytes())
    return h.hexdigest()


def snapshot():
    z = np.load(OUT / "mask.npz")
    mask_content = hashlib.sha256("".join(
        "%s:%s" % (k, array_hash(k, z[k])) for k in sorted(z.files)).encode()).hexdigest()
    return {
        "props.json": sha256_bytes((OUT / "props.json").read_bytes()),
        "route.json": sha256_bytes((OUT / "route.json").read_bytes()),
        "ground.json": sha256_bytes((OUT / "ground.json").read_bytes()),
        "map.png": sha256_bytes((OUT / "map.png").read_bytes()),
        "mask.npz.content": mask_content,
    }


def run(cmd):
    r = subprocess.run([str(c) for c in cmd], cwd=str(ROOT), capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit("command failed: %s\n%s\n%s" % (cmd, r.stdout[-2000:], r.stderr[-2000:]))
    return r


def main() -> int:
    tool = ROOT / "probes/free-roam-prop/tools"
    build = [sys.executable, tool / "build_props.py"]
    resolve = [NODE, tool / "resolve_r04.mjs"]
    if EXTENDED:
        coll = [NODE, tool / "build_colliders_r04.mjs"]
        run(coll)
        coll_a = sha256_bytes(MANIFEST.read_bytes())
        run(coll)
        coll_b = sha256_bytes(MANIFEST.read_bytes())
        coll_ok = coll_a == coll_b
        build += ["--manifest", MANIFEST, "--out", OUT, "--no-region"]
        resolve += ["--manifest", MANIFEST, "--dir", OUT]
    else:
        coll_a = coll_b = None
        coll_ok = True

    run(build)
    a = snapshot()
    run(build)
    b = snapshot()
    build_ok = a == b

    run(resolve)
    r1 = json.loads((OUT / "resolver.json").read_text(encoding="utf-8"))
    run(resolve)
    r2 = json.loads((OUT / "resolver.json").read_text(encoding="utf-8"))
    resolver_ok = (
        r1["headOn"]["stopHash"] == r2["headOn"]["stopHash"]
        and r1["route"]["hash"] == r2["route"]["hash"]
        and r1["glancing"]["hash"] == r2["glancing"]["hash"]
        and [t["hash"] for t in r1["tunnelling"]] == [t["hash"] for t in r2["tunnelling"]]
    )

    doc = {
        "kind": "free-roam-prop.determinism", "version": 1,
        "chain": "free-roam-r04-extended" if EXTENDED else "committed-p66",
        "manifest": str(MANIFEST.relative_to(ROOT)).replace("\\", "/"),
        "build": {"runA": a, "runB": b, "identical": build_ok},
        "resolver": {
            "identical": resolver_ok,
            "headOn": r2["headOn"]["stopHash"],
            "route": r2["route"]["hash"],
            "glancing": r2["glancing"]["hash"],
            "tunnelling": [t["hash"] for t in r2["tunnelling"]],
        },
        "note": "mask.npz is hashed by array content; the ZIP container carries "
                "timestamps and its file hash is not deterministic",
        "result": "PASS" if (build_ok and resolver_ok and coll_ok) else "FAIL",
    }
    if EXTENDED:
        doc["colliderManifest"] = {"runA": coll_a, "runB": coll_b, "identical": coll_ok}
    name = "determinism-extended.json" if EXTENDED else "determinism.json"
    (OUT / name).write_text(json.dumps(doc, indent=1) + "\n", encoding="utf-8")
    print(json.dumps(doc, indent=1))
    return 0 if doc["result"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
