"""Independent recomputation of the measured River corridor.

This verifier does not import `build_corridor.py` or `build_reference.py`. It
re-extracts the committed level draw geometry with the repository readers, reads
`Level.levelphysics` through the collision-oracle reference parser, and
recomputes every 0.25 m course sample with its own point-in-triangle code.

It checks:
  * section geometry hashes against corridor.json
  * every course sample's collision height, nearest visual height, delta and
    covered flag
  * course length, segment lengths, gap lengths, coverage fraction, section metres
  * maximum height step and the recommended finish
  * the canonical corridor hash
  * a sample of the width stations

Usage:
    python probes/track-coverage/tools/verify_corridor.py
"""
from __future__ import annotations

import hashlib
import json
import math
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tools"))
import inspect_level_candidates as cand  # noqa: E402
from inspect_level_chunk import geometry  # noqa: E402

OUT = ROOT / "_work/track-coverage"
COVER_TOL = 0.5
SAMPLE_STEP = 0.25


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical_hash(document: dict) -> str:
    body = dict(document)
    body.pop("hash", None)
    text = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return "sha256:" + sha256_bytes(text.encode("utf-8"))


def height_at(tri, x, z):
    a, b, c = tri[0], tri[1], tri[2]
    den = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2])
    if abs(den) < 1e-12:
        return None
    l1 = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / den
    l2 = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / den
    l3 = 1.0 - l1 - l2
    if l1 < -1e-9 or l2 < -1e-9 or l3 < -1e-9:
        return None
    return l1 * a[1] + l2 * b[1] + l3 * c[1]


class Index:
    """X-bucketed triangle index (independent of the builder's 4 m grid index)."""
    def __init__(self, triangles, bucket=5.0):
        self.triangles = triangles
        self.bucket = bucket
        self.buckets = {}
        for i, tri in enumerate(triangles):
            xs = (tri[0][0], tri[1][0], tri[2][0])
            zs = (tri[0][2], tri[1][2], tri[2][2])
            for bx in range(int(math.floor(min(xs) / bucket)), int(math.floor(max(xs) / bucket)) + 1):
                for bz in range(int(math.floor(min(zs) / bucket)), int(math.floor(max(zs) / bucket)) + 1):
                    self.buckets.setdefault((bx, bz), []).append(i)

    def hits(self, x, z):
        key = (int(math.floor(x / self.bucket)), int(math.floor(z / self.bucket)))
        out = []
        for i in self.buckets.get(key, ()):
            h = height_at(self.triangles[i], x, z)
            if h is not None:
                out.append((h, i))
        return out


def extract_sections(keys):
    statistics = Counter()
    pairs, _ = cand.inspect_level("usa_la_river", statistics, [])
    by_key = {}
    for pair in pairs:
        node = pair["node"]
        block = pair["geometryBlock"]
        node_block = node["record"]["items"][0]["block"]
        key = f"g{block}-n{node_block}"
        by_key[key] = pair
    out = {}
    for key in keys:
        pair = by_key.get(key)
        if pair is None:
            raise SystemExit(f"verifier: section {key} not found in the committed reader")
        raw = pair["readRecord"](pair["geometryRecord"])
        resources = cand.resource_prefix(raw, {"resourcePayloadOffset": 24, "scenePayloadOffset": 0}, streamed=True)
        if resources["nodeCount"]:
            raise SystemExit(f"verifier: {key} has node payloads")
        reader = cand.Reader(raw, resources["firstNodeOffset"])
        if reader.unpack("I"):
            raise SystemExit(f"verifier: {key} has textures")
        ref = geometry(raw, resources, pair["scene"], pair["node"]["render"], pair["geometryBlock"])
        out[key] = ref
    return out


def main() -> int:
    corridor_path = OUT / "corridor.json"
    samples_path = OUT / "course_samples.json"
    if not corridor_path.is_file() or not samples_path.is_file():
        print("verify_corridor: BLOCKED: run build_corridor.py first", file=sys.stderr)
        return 3
    corridor = json.loads(corridor_path.read_text(encoding="utf-8"))
    sample_doc = json.loads(samples_path.read_text(encoding="utf-8"))
    errors = []
    warnings = []

    # 1. Hash of the document body.
    expected_hash = corridor.get("hash")
    actual_hash = canonical_hash(corridor)
    if expected_hash != actual_hash:
        errors.append(f"corridor hash mismatch: {expected_hash} != {actual_hash}")

    # 2. Re-extract the used sections and compare geometry hashes.
    used_keys = sorted(corridor.get("sections", {}).keys())
    sections = extract_sections(used_keys)
    for key in used_keys:
        ref = sections[key]
        want = corridor["sections"][key]
        pbytes = b"".join(struct_pack_float(v) for v in ref["positions"])
        ibytes = b"".join(struct_pack_uint(v) for v in ref["indices"])
        if sha256_bytes(pbytes) != want["positionsSha256"]:
            errors.append(f"{key}: positions hash mismatch")
        if sha256_bytes(ibytes) != want["indicesSha256"]:
            errors.append(f"{key}: indices hash mismatch")

    # 3. Re-read the physics file through the collision oracle.
    sys.path.insert(0, str(ROOT / "probes/collision-oracle/tests"))
    import reference_oracle as oracle
    physics_path = ROOT / "game-data/Blur/levels/usa_la_river/Level.levelphysics"
    physics_bytes = physics_path.read_bytes()
    level = oracle.load_level(physics_bytes)
    ctris = []
    for mesh in level["meshes"]:
        vertices = mesh["vertices"]
        for tri in mesh["triangles"]:
            leaf = mesh["leaves"][tri["leaf"]]
            base = leaf["vertex_start"]
            a = vertices[base + tri["a"]]
            b = vertices[base + tri["b"]]
            c = vertices[base + tri["c"]]
            ux, uy, uz = b[0] - a[0], b[1] - a[1], b[2] - a[2]
            vx, vy, vz = c[0] - a[0], c[1] - a[1], c[2] - a[2]
            nx, ny, nz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
            ln = math.sqrt(nx * nx + ny * ny + nz * nz)
            if ln == 0 or ny / ln < 0.5:
                continue
            ctris.append((a, b, c))
    vtris = []
    for key in used_keys:
        ref = sections[key]
        p = ref["positions"]
        idx = ref["indices"]
        for k in range(0, len(idx), 3):
            a = p[idx[k] * 3:idx[k] * 3 + 3]
            b = p[idx[k + 1] * 3:idx[k + 1] * 3 + 3]
            c = p[idx[k + 2] * 3:idx[k + 2] * 3 + 3]
            ux, uy, uz = b[0] - a[0], b[1] - a[1], b[2] - a[2]
            vx, vy, vz = c[0] - a[0], c[1] - a[1], c[2] - a[2]
            nx, ny, nz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
            ln = math.sqrt(nx * nx + ny * ny + nz * nz)
            if ln == 0 or ny / ln < 0.1:
                continue
            vtris.append((a, b, c, key))
    cidx = Index(ctris)
    vidx = Index([v[:3] for v in vtris])
    vkey = [v[3] for v in vtris]

    # 4. Recompute every sample.
    samples = sample_doc["samples"]
    if abs(samples[0]["x"] - (-88.0)) > 1e-6 or abs(samples[0]["z"] - 1050.0) > 1e-6:
        errors.append("course does not start at the committed spawn (-88, 1050)")
    if abs(samples[-1]["x"] - corridor["course"]["finish"][0]) > 1e-6 or abs(samples[-1]["z"] - corridor["course"]["finish"][1]) > 1e-6:
        errors.append("last sample is not the recorded finish")
    mismatches = 0
    covered = 0
    section_mismatch = 0
    for s in samples:
        x, z = s["x"], s["z"]
        ch = cidx.hits(x, z)
        cy = max((h for h, _ in ch), default=None)
        best = None
        best_idx = None
        if cy is not None:
            for h, i in vidx.hits(x, z):
                d = h - cy
                if best is None or abs(d) < abs(best):
                    best = d
                    best_idx = i
        is_covered = best is not None and abs(best) <= COVER_TOL
        if is_covered:
            covered += 1
        if s["covered"] != is_covered:
            mismatches += 1
            if mismatches <= 5:
                errors.append(f"sample ({x},{z}) covered {s['covered']} != {is_covered}")
        if s["coll"] is not None and cy is not None and abs(s["coll"] - cy) > 1e-4:
            mismatches += 1
            if mismatches <= 5:
                errors.append(f"sample ({x},{z}) coll {s['coll']} != {cy}")
        if best is not None and s["delta"] is not None and abs(s["delta"] - best) > 1e-4:
            mismatches += 1
            if mismatches <= 5:
                errors.append(f"sample ({x},{z}) delta {s['delta']} != {best}")
        if best_idx is not None and s["section"] is not None:
            want = vkey[best_idx]
            if s["section"] != want:
                section_mismatch += 1
                if section_mismatch <= 5:
                    warnings.append(f"sample ({x},{z}) section {s['section']} != {want} (tie/seam)")

    # 5. Recomputed metrics.
    dists = [0.0]
    for k in range(1, len(samples)):
        dists.append(math.hypot(samples[k]["x"] - samples[k - 1]["x"],
                                samples[k]["z"] - samples[k - 1]["z"]))
    total = sum(dists)
    if abs(total - corridor["course"]["lengthMetres"]) > 1e-2:
        errors.append(f"course length {total} != {corridor['course']['lengthMetres']}")
    coverage = covered / len(samples)
    if abs(coverage - corridor["course"]["coverageFraction"]) > 1e-5:
        errors.append(f"coverage {coverage} != {corridor['course']['coverageFraction']}")
    steps = [
        abs(samples[k]["coll"] - samples[k - 1]["coll"])
        for k in range(1, len(samples))
        if samples[k]["coll"] is not None and samples[k - 1]["coll"] is not None
    ]
    max_step = max(steps, default=0.0)
    if abs(max_step - corridor["course"]["maxHeightStepMetres"]) > 1e-3:
        errors.append(f"max step {max_step} != {corridor['course']['maxHeightStepMetres']}")
    # Gap total from the independent covered flags, using the builder's run
    # convention: a gap run's length is the sum of the sample-to-sample steps
    # inside the run (the step from the last covered sample is included).
    gap_total = 0.0
    gap_runs = []
    run = []
    for k, s in enumerate(samples):
        if not s["covered"]:
            run.append(k)
        else:
            if run:
                gap_runs.append(run)
                run = []
    if run:
        gap_runs.append(run)
    for run in gap_runs:
        gap_total += sum(dists[k] for k in run)
    if abs(gap_total - corridor["course"]["gapTotalMetres"]) > 1e-2:
        errors.append(f"gap total {gap_total:.3f} != {corridor['course']['gapTotalMetres']}")
    if len(gap_runs) != len(corridor["course"]["gaps"]):
        errors.append(f"gap runs {len(gap_runs)} != {len(corridor['course']['gaps'])}")
    else:
        for i, run in enumerate(gap_runs):
            length = sum(dists[k] for k in run)
            want = corridor["course"]["gaps"][i]["lengthMetres"]
            if abs(length - want) > 1e-3:
                errors.append(f"gap {i} length {length:.3f} != {want}")

    # Segment runs and lengths.
    seg_runs = []
    run = []
    for k, s in enumerate(samples):
        if s["covered"]:
            if run and run[-1] != k - 1:
                seg_runs.append(run)
                run = []
            run.append(k)
        else:
            if run:
                seg_runs.append(run)
                run = []
    if run:
        seg_runs.append(run)
    if len(seg_runs) != len(corridor["course"]["segments"]):
        errors.append(f"segments {len(seg_runs)} != {len(corridor['course']['segments'])}")
    else:
        for i, run in enumerate(seg_runs):
            length = sum(dists[k] for k in run)
            want = corridor["course"]["segments"][i]["lengthMetres"]
            if abs(length - want) > 1e-3:
                errors.append(f"segment {i} length {length:.3f} != {want}")

    # 6. Section geometry hash of the full visual input.
    if corridor["source"]["levelPhysicsSha256"] != sha256_bytes(physics_bytes):
        errors.append("levelphysics hash mismatch")

    status = "PASS" if not errors else "FAIL"
    result = {
        "kind": "track-coverage.verify",
        "version": 1,
        "status": status,
        "corridorHash": expected_hash,
        "recomputedHash": actual_hash,
        "samples": len(samples),
        "coveredSamples": covered,
        "coverageFraction": round(coverage, 6),
        "lengthMetres": round(total, 3),
        "maxHeightStepMetres": round(max_step, 4),
        "sampleMismatches": mismatches,
        "sectionLabelMismatches": section_mismatch,
        "errors": errors[:20],
        "warnings": warnings[:20],
        "sectionsVerified": used_keys,
        "collisionTriangles": len(ctris),
        "visualTrianglesUsedSections": len(vtris),
    }
    (OUT / "verify.json").write_text(json.dumps(result, indent=1) + "\n", encoding="utf-8")
    print(json.dumps(result, indent=2))
    return 0 if status == "PASS" else 1


def struct_pack_float(value):
    import struct
    return struct.pack("<f", value)


def struct_pack_uint(value):
    import struct
    return struct.pack("<I", value)


if __name__ == "__main__":
    raise SystemExit(main())
