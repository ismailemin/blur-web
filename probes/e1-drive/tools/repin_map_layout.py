"""Re-pin a map layout after a producer changed it.

Updates, for one map id:
  * `probes/e1-drive/web/map-registry.js` -> `pins.layoutFileSha256` and
    `pins.layoutContentHash` (and `pins.layoutBytes` when present);
  * `probes/e2e/expected.json` -> `solo.<map>.layoutHash`.

Usage:
  python probes/e1-drive/tools/repin_map_layout.py longbeach observatory ...
"""

import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
REGISTRY = ROOT / "probes/e1-drive/web/map-registry.js"
EXPECTED = ROOT / "probes/e2e/expected.json"


def repin(map_id: str) -> None:
    layout_path = ROOT / "_work/e1-drive" / map_id / "layout.json"
    doc = json.loads(layout_path.read_text(encoding="utf-8"))
    content = doc["hash"].replace("sha256:", "")
    file_sha = hashlib.sha256(layout_path.read_bytes()).hexdigest()
    size = len(layout_path.read_bytes())

    text = REGISTRY.read_text(encoding="utf-8")
    marker = "  %s: Object.freeze({" % map_id
    if marker not in text:
        marker = "  '%s': Object.freeze({" % map_id
    start = text.index(marker)
    end = text.index("\n  })", start)
    block = text[start:end]
    if "layoutContentHash:" not in block:
        raise SystemExit("no layoutContentHash in %s pins" % map_id)
    # `pins` carries layoutContentHash/layoutFileSha256; `mpPins` carries
    # layoutHash/layoutFileSha256/layoutBytes. Both describe the same file, so
    # every occurrence is updated together.
    block = re.sub(r"layoutContentHash: 'sha256:[0-9a-f]{64}'",
                   "layoutContentHash: 'sha256:%s'" % content, block)
    block = re.sub(r"layoutHash: 'sha256:[0-9a-f]{64}'",
                   "layoutHash: 'sha256:%s'" % content, block)
    block = re.sub(r"layoutFileSha256: 'sha256:[0-9a-f]{64}'",
                   "layoutFileSha256: 'sha256:%s'" % file_sha, block)
    block = re.sub(r"layoutBytes: \d+", "layoutBytes: %d" % size, block)
    REGISTRY.write_text(text[:start] + block + text[end:], encoding="utf-8")

    expected = json.loads(EXPECTED.read_text(encoding="utf-8"))
    entry = expected["solo"].get(map_id)
    if entry is None:
        raise SystemExit("no solo.%s anchor" % map_id)
    entry["layoutHash"] = doc["hash"]
    EXPECTED.write_text(json.dumps(expected, indent=2, ensure_ascii=False) + "\n",
                        encoding="utf-8")
    print("%-12s content %s file %s bytes %d" % (map_id, content[:16], file_sha[:16], size))


if __name__ == "__main__":
    for argument in sys.argv[1:]:
        repin(argument)
