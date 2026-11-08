"""Recover Blur's UI design tokens from the retail XT UI database.

Source: `gamedata.pak : \\gamedata\\xt\\ui.bin` (the runtime FLSK v2 database,
1,004,480 bytes), decoded with the committed `probes/powerups/tools/xt_decode.py`.

Recovered here, all retail-exact:
  * 56 `UISpriteColours` gradient styles (4 corner RGB values)
  * 15 `UIFontStyle` records (font name, tracking, height, italics)
  * per-screen `UIStaticText` sizes and the font style each uses
  * `UIStaticBox` 9-slice records (cornerx/cornery/corneru/cornerv)
  * every `UITextureParam` atlas region (filename + UV rect)
  * named HUD anchors and the 1280x720 UI reference space

Writes `_work/ui-art/design-tokens.json`.  Nothing is guessed: a value that is
not serialized is absent, and `substitute` values are labelled as such.
"""
from __future__ import annotations

import collections
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import uiart  # noqa: E402
sys.path.insert(0, str(uiart.ROOT / "probes" / "powerups" / "tools"))
import xt_decode  # noqa: E402

OUT = uiart.ROOT / "_work" / "ui-art"


def value_of(node):
    if isinstance(node, dict):
        if "value" in node:
            return node["value"]
        if "label" in node:
            return node["label"]
    return node


def vec(node, keys=("x", "y", "z")):
    if not isinstance(node, dict):
        return None
    return {k: round(node[k], 6) for k in keys if isinstance(node.get(k), (int, float))}


def colour_bytes(rgb):
    """`C_UIColour::Set(float)` truncates at x*255 (UIColourClasses.h:89-92)."""
    return [max(0, min(255, int(v * 255.0))) for v in rgb]


def hex_of(rgb):
    return "#%02X%02X%02X" % tuple(colour_bytes(rgb))


def walk(node, out, depth=0):
    if not isinstance(node, dict) or depth > 24:
        return
    out.append(node)
    elements = node.get("Elements")
    if isinstance(elements, dict):
        for item in elements.get("items", []):
            walk(item, out, depth + 1)


def main() -> int:
    data, info = uiart.load("gamedata.pak", "\\gamedata\\xt\\ui.bin")
    xt = xt_decode.Flask(data)

    sprite_colours = []
    font_styles = []
    screens = []
    boxes = []
    text_sizes = collections.defaultdict(collections.Counter)
    texture_use = collections.defaultdict(lambda: {"count": 0, "rects": set()})
    nodes = 0

    for index in range(len(xt.records)):
        kind = xt.type_name(xt.record_type(index))
        if kind == "UISpriteColours":
            rec = xt.decode_record(index)
            corners = {}
            for key in ("top_left", "top_right", "bottom_left", "bottom_right"):
                node = rec.get(key)
                if isinstance(node, dict):
                    rgb = [node["r"], node["g"], node["b"]]
                    corners[key] = {"rgb": [round(v, 6) for v in rgb],
                                    "bytes": colour_bytes(rgb),
                                    "hex": hex_of(rgb)}
            sprite_colours.append({"name": value_of(rec.get("name")),
                                   "corners": corners})
        elif kind == "UIFontStyle":
            rec = xt.decode_record(index)
            passes = []
            rp = rec.get("render_passes")
            if isinstance(rp, dict):
                for item in rp.get("items", []):
                    passes.append({k: value_of(item.get(k)) for k in
                                   ("colour_style", "alpha", "overide_name",
                                    "render_type", "blend_mode", "offsetx",
                                    "offsety", "offsetz", "offset_proportional")})
            font_styles.append({
                "style_name": value_of(rec.get("style_name")),
                "font_name": value_of(rec.get("font_name")),
                "tracking": round(rec.get("tracking", 0.0), 8),
                "height_percentage": round(rec.get("height_percentage", 0.0), 8),
                "italics": rec.get("italics"),
                "pixel_boundary_x": rec.get("pixel_boundary_x"),
                "pixel_boundary_y": rec.get("pixel_boundary_y"),
                "render_passes": passes,
            })
        elif kind == "UIScreen":
            rec = xt.decode_record(index)
            flat = []
            walk(rec, flat)
            nodes += len(flat)
            elements = rec.get("Elements")
            count = elements.get("length") if isinstance(elements, dict) else 0
            used_styles = set()
            for node in flat:
                t = node.get("$type")
                style = value_of(node.get("colour_style"))
                if style:
                    used_styles.add(style)
                if t == "UIStaticText":
                    styles = node.get("styles")
                    style_name = value_of(styles.get("name")) if isinstance(styles, dict) else None
                    size = vec(node.get("size"))
                    if style_name and size and "y" in size:
                        text_sizes[style_name][round(size["y"], 3)] += 1
                if t == "UIStaticBox":
                    textures = []
                    tp = node.get("textures")
                    if isinstance(tp, dict):
                        for p in tp.get("items", []):
                            filename = value_of(p.get("filename"))
                            pos = vec(p.get("pos"), ("u", "v"))
                            size = vec(p.get("size"), ("u", "v"))
                            if filename:
                                textures.append({"filename": filename,
                                                 "pos": pos, "size": size})
                    boxes.append({
                        "screen": value_of(rec.get("Name")),
                        "name": value_of(node.get("name")),
                        "size": vec(node.get("size")),
                        "cornerx": node.get("cornerx"),
                        "cornery": node.get("cornery"),
                        "corneru": node.get("corneru"),
                        "cornerv": node.get("cornerv"),
                        "textures": textures,
                    })
                if t in ("UIStaticGraphic", "UIStaticShape", "UISafeArea"):
                    tp = node.get("textures")
                    if isinstance(tp, dict):
                        for p in tp.get("items", []):
                            filename = value_of(p.get("filename"))
                            if not filename:
                                continue
                            pos = vec(p.get("pos"), ("u", "v"))
                            size = vec(p.get("size"), ("u", "v"))
                            entry = texture_use[filename]
                            entry["count"] += 1
                            if pos and size:
                                entry["rects"].add((
                                    round(pos.get("u", 0.0), 6), round(pos.get("v", 0.0), 6),
                                    round(size.get("u", 0.0), 6), round(size.get("v", 0.0), 6)))
            screens.append({
                "name": value_of(rec.get("Name")),
                "guiTable": value_of(rec.get("GuiTableName")),
                "elements": count,
                "decodedNodes": len(flat),
                "colourStyles": sorted(used_styles),
                "onNext": value_of(rec.get("OnNext")),
                "onBack": value_of(rec.get("OnBack")),
            })
        elif kind == "UiXtConfig":
            rec = xt.decode_record(index)
            config = {
                "CommonShapes": [value_of(x) for x in rec.get("CommonShapes", {}).get("items", [])]
                if isinstance(rec.get("CommonShapes"), dict) else [],
                "FrontendShapes": [value_of(x) for x in rec.get("FrontendShapes", {}).get("items", [])]
                if isinstance(rec.get("FrontendShapes"), dict) else [],
                "MapShapes": [value_of(x) for x in rec.get("MapShapes", {}).get("items", [])]
                if isinstance(rec.get("MapShapes"), dict) else [],
                "PulseDefaultFreq": rec.get("PulseDefaultFreq"),
                "PulseEarnXpFreq": rec.get("PulseEarnXpFreq"),
            }

    textures = []
    for filename, entry in texture_use.items():
        textures.append({
            "filename": filename,
            "uses": entry["count"],
            "rects": [list(r) for r in sorted(entry["rects"])],
        })
    textures.sort(key=lambda t: (-t["uses"], t["filename"].lower()))

    token = {
        "scope": "retail UI design tokens recovered from gamedata.pak ui.bin",
        "source": {
            "pak": info["pak"],
            "path": info["path"],
            "bytes": info["logicalBytes"],
            "sha256": info["sha256"],
            "recordCount": len(xt.records),
            "typeCount": len(xt.types),
            "screensDecoded": len(screens),
            "decodedNodes": nodes,
        },
        "retailExact": {
            "referenceSpace": {
                "width": 1280,
                "height": 720,
                "source": "Simple2d.cpp:502 default clip size XtVec2(1280,720)",
            },
            "spriteColours": sprite_colours,
            "fontStyles": font_styles,
            "textSizes": {name: dict(sorted(counts.items()))
                          for name, counts in sorted(text_sizes.items())},
            "nineSliceBoxes": boxes,
            "textureRegions": textures,
            "xtConfig": config,
            "screens": sorted(screens, key=lambda s: (s["name"] or "").lower()),
            "colourQuantisation": "(U8)(clamp(v,0,1)*255) truncation, UIColourClasses.h:89",
        },
        "substitute": {
            "note": ("Values here are derived for the web shell, not read from the "
                     "game.  hex values are the retail float RGB quantised exactly "
                     "as C_UIColour::Set does; spacing and font stacks are our "
                     "choices and are labelled as such."),
            "hexFromRetailFloat": True,
            "referenceScale": {
                "cssPxPerUiUnit": "viewportWidth/1280 (uniform scale; UI is 16:9 authored)",
                "warning": "do not scale non-uniformly: corner insets are in UI units",
            },
            "fontStacks": {
                "display": ["Swis721 Hv BT", "Bitstream Swiss 721", "Helvetica Neue", "Arial", "sans-serif"],
                "displaySlant": ["Myers Sans Bold Slant", "Swis721 Hv BT Oblique", "Arial Black", "sans-serif"],
                "body": ["Swis721 BT Roman", "Bitstream Swiss 721 Roman", "Helvetica Neue", "Arial", "sans-serif"],
            },
            "fallbackRequirement": {
                "family": "Helvetica-metric clone (Swiss 721 / Nimbus Sans / Arimo)",
                "why": "retail polygons are Swis721 (Helvetica clone); a grotesque with different widths breaks the tracked menu labels",
                "mustMatch": ["advance widths within 2% at 24px", "cap height ratio", "italic slant for Myers"],
            },
        },
    }
    uiart.write_json(OUT / "design-tokens.json", token)
    print(f"sprite colours {len(sprite_colours)} font styles {len(font_styles)} "
          f"screens {len(screens)} boxes {len(boxes)} textures {len(textures)} "
          f"nodes {nodes}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
