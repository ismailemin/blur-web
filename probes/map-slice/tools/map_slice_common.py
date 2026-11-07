#!/usr/bin/env python3
"""Shared level configuration for the map-slice tools.

The slice/binding/render tools were first written for ``usa_amboy``. This
module factors out the small number of level-specific names and constants so the
same tools can build another level (``spa_barcelona_gracia``) without changing
Amboy defaults or output bytes.

Only names and measurement windows live here. No geometry, material or texture
value is level-specific.
"""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]

# Short package names. usa_amboy keeps the committed ``amboy`` directory and
# texture ids; every other level uses the trailing map token if it is unique
# enough, otherwise the full level id.
SHORT_NAMES = {
    "usa_amboy": "amboy",
    "spa_barcelona_gracia": "gracia",
}


def short_name(level: str) -> str:
    return SHORT_NAMES.get(level, level)


def package_dir(level: str) -> Path:
    return ROOT / "_work/map-slice" / short_name(level)


def texture_dir(level: str) -> Path:
    return ROOT / "_work/map-slice" / (short_name(level) + "-textures")


def render_dir(level: str) -> Path:
    return ROOT / "_work/map-slice" / (short_name(level) + "-render")


# Vertical spawn-ray window. Amboy's committed package was measured with
# startY=50, minY=-50, maxY=5; keep those exact values so a rebuild is
# byte-identical. For a level whose ground is far outside that window the ray is
# widened around the candidate layout ground (width recorded in slice.json).
LEGACY_RAY_BOUNDS = {
    "usa_amboy": {"startY": 50.0, "minY": -50.0, "maxY": 5.0},
}
RAY_HALF_WINDOW_M = 50.0


def ray_bounds(level: str, layout_ground: float) -> dict:
    """Return the documented vertical-ray window for a level."""
    if level in LEGACY_RAY_BOUNDS:
        return dict(LEGACY_RAY_BOUNDS[level])
    return {
        "startY": float(layout_ground) + RAY_HALF_WINDOW_M,
        "minY": float(layout_ground) - RAY_HALF_WINDOW_M,
        "maxY": float(layout_ground) + RAY_HALF_WINDOW_M,
    }
