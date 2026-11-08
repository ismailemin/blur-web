"""Render docs/work/analysis/audio-catalog.md from the decoded catalog.

The document is generated so the tables cannot drift from the JSON evidence.
No game data is embedded; only paths, counts, hashes and retail names.
"""
from __future__ import annotations

import json
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "_work/audio"
DOC = ROOT / "docs/work/analysis/audio-catalog.md"


def md(value) -> str:
    return str(value).replace("|", "\\|")


def fmt_bytes(n: int) -> str:
    if n >= 1024 * 1024:
        return f"{n:,} ({n / (1024 * 1024):.1f} MiB)"
    if n >= 1024:
        return f"{n:,} ({n / 1024:.1f} KiB)"
    return f"{n:,}"


def variant_cell(v: dict) -> str:
    if not v.get("waveUid"):
        return f"{md(v.get('component'))} — {v.get('reason')}"
    bank = md(v.get("bankName"))
    idx = v.get("waveIndex")
    wave = md(v.get("wave"))
    off = v.get("dataStart")
    dur = v.get("durationSeconds")
    loop = "loop" if v.get("loop") else "one-shot"
    codec = v.get("codec", "?")
    rate = v.get("sampleRate")
    ch = v.get("channels")
    status = v.get("status")
    reason = f" ({v['reason']})" if v.get("reason") else ""
    return (f"`{bank}#{idx}:{wave}`<br>@0x{off:x} · {codec} {rate}/{ch}ch · "
            f"{dur}s · {loop} · **{status}**{reason}")


def main() -> None:
    catalog = json.loads((OUT / "audio-catalog.json").read_text(encoding="utf-8"))
    manifest = json.loads((OUT / "audio-manifest.json").read_text(encoding="utf-8"))
    contract = json.loads((OUT / "integration-contract.json").read_text(encoding="utf-8"))
    verify = json.loads((OUT / "audio-catalog-verify.json").read_text(encoding="utf-8"))
    banks = catalog["banks"]
    entities = catalog["entities"]
    graphs = catalog["graphs"]
    events = catalog["events"]
    summary = catalog["bankSummary"]
    es = catalog["entitySummary"]
    gs = catalog["graphSummary"]
    evs = catalog["eventSummary"]
    man = manifest

    def family(asset: str) -> str:
        n = Path(asset.replace("\\", "/")).name.lower()
        if n in ("frontendui.baf", "garageui.baf", "ingameui.baf") or n.startswith("voiceoverui_"):
            return "UI / voice"
        if any(k in n for k in ("music", "vista")) or n.startswith(("menu", "ingame", "checkpoint", "boss", "destruction")):
            return "music"
        if n.startswith("env_"):
            return "environment"
        if n.startswith(("do_", "po_")):
            return "dynamic object"
        if n.startswith("wheel_"):
            return "wheel"
        if n in ("car_collisions.baf", "car_common.baf", "proximity.baf", "pickups.baf"):
            return "shared"
        if any(k in n for k in ("_i4", "_i5", "_i6", "_v6", "_v8", "_v10", "_v12",
                                "_w12", "_flat4", "ccxr", "chevy", "dodge", "ford",
                                "lotus", "nissan", "renault", "toyota", "vw_", "bmw",
                                "audi", "gm_", "f1_", "lr_")):
            return "vehicle"
        return "other"

    fams = Counter(family(a) for a in banks)
    fam_waves = Counter()
    fam_loops = Counter()
    fam_stream = Counter()
    for a, b in banks.items():
        f = family(a)
        fam_waves[f] += len(b["waves"])
        fam_loops[f] += sum(1 for w in b["waves"] if w.get("loop"))
        fam_stream[f] += int(b["streaming"])

    by_cat = {}
    for e in events:
        by_cat.setdefault(e["category"], []).append(e)
    for rows in by_cat.values():
        rows.sort(key=lambda e: e["event"])

    lines: list[str] = []
    add = lines.append
    add("# Audio bank, entity and event catalog")
    add("")
    add("**Status:** decoded/catalogued and verified; **not** integrated into `e1-drive`.")
    add("")
    add("**Date:** 8 November 2026.")
    add("")
    add("**Scope:** every BAF bank shipped in `root.pak` and `root_streaming.pak`, the 228")
    add("`AudioEntityDef`s, the 365 audio `.dat` graphs, the UI/race/power-up event map,")
    add("the decoded manifest and the web-consumer integration contract.")
    add("")
    add("**Non-claim:** this is not the retail mixer, not the Ovis runtime and not a")
    add("full-game audio implementation. No audio is synthesised or guessed. A wave is")
    add("decoded from the retail BAF, or reported `decodable`/`unsupported` with a typed")
    add("reason. Streaming music and ambience are catalogued but not decoded.")
    add("")
    add("## 1. Summary")
    add("")
    add("| Measure | Value |")
    add("| --- | ---: |")
    add(f"| Audio banks | **{summary['banks']}** ({summary['pakCounts']['root.pak']['banks']} in `root.pak`, {summary['pakCounts']['root_streaming.pak']['banks']} in `root_streaming.pak`) |")
    add(f"| Waves | **{summary['waves']:,}** |")
    add(f"| Codecs | `uADPCM4Bit` {summary['codecs'].get('uADPCM4Bit', 0):,}; `PCM16` {summary['codecs'].get('PCM16', 0)} |")
    add(f"| Sample rates | 48 kHz {summary['sampleRates'].get('48000', 0):,}; 36 kHz {summary['sampleRates'].get('36000', 0):,} |")
    add(f"| Channels | mono {summary['channels'].get('1', 0):,}; stereo {summary['channels'].get('2', 0):,} |")
    add(f"| Loops / one-shots | {summary['loops']:,} / {summary['oneShots']:,} |")
    add(f"| Declared wave payload | {fmt_bytes(summary['waveBytes'])} |")
    add(f"| Streaming banks | **{summary['streamingBanks']}** (music + environment ST banks) |")
    add(f"| `AudioEntityDef` records | **{es['entities']}** in {len(es['groups'])} groups; {es['objects']} audio objects |")
    add(f"| Audio graphs | **{gs['count']}** `.dat`; {gs['withSounds']} contain sound components; {gs['totalSounds']:,} sound components |")
    add(f"| Mapped events | **{evs['count']}** |")
    add(f"| Event status | decoded **{evs['byStatus'].get('decoded', 0)}**, decodable **{evs['byStatus'].get('decodable', 0)}**, unsupported **{evs['byStatus'].get('unsupported', 0)}** |")
    add(f"| Decoded manifest | **{man['counts']['total']}** waves, {fmt_bytes(man['bytes']['total'])} |")
    add(f"| Newly decoded | {man['counts']['newlyDecoded']} waves, {fmt_bytes(man['bytes']['newlyDecoded'])} |")
    add(f"| Reused decoded | {man['counts']['existingDecoded']} waves, {fmt_bytes(man['bytes']['existingDecoded'])} |")
    add(f"| Verifier | **{verify['checks']:,} checks, {verify['failed']} failures** |")
    add("")
    add("The practical set covers **all UI, race and power-up events** that map to a")
    add("shipped non-streaming wave: 44 UI, 71 race, 47 power-up and 12 tyre events are")
    add("`decoded`; 14 collision-world material routes reuse the already decoded")
    add("`tyre-collision` WAVs. Seven engine layers (the 720 idle plus six RPM loops)")
    add("reuse the already decoded P62/P71 WAVs. Nineteen non-streaming music transition")
    add("70 music tracks/loops in streaming banks are `unsupported/streaming-container`.")
    add("")
    add("## 2. Sources and method")
    add("")
    add("| Source | Use |")
    add("| --- | --- |")
    add("| `root.pak` (`packet-zlib`, codec 4) | 126 `\\audio\\*.baf` banks and 365 `\\audio\\dat\\*.dat` graphs |")
    add("| `root_streaming.pak` (raw, codec 1) | 67 `\\env_*.baf`, `\\menumusic.baf`, `\\ingamemusic.baf`, `\\ingamecustommusic.baf`, `\\vistamusic.baf` |")
    add("| `gamedata.pak:\\gamedata\\xt\\audioentities.bin` | 228 `AudioEntityDef` records (FLSK v2) |")
    add("| `gamedata.pak:\\gamedata\\xt\\audio.bin` | 367 `AudioObject` names, 228 `AudioEntityProxy`, 11 `AudioEntityGroup` |")
    add("| `root.pak:\\audio\\datbanklists.wbl` | graph -> bank lists for 365 graphs (285 with banks) |")
    add("| `upstream` headers/sources | BAF/ADPCM, AOBJ component sizes, `GetLevel`/`GetFrequency`, `E_EffectMaterial` |")
    add("")
    add("The BAF reader parses `BANK`/`WAVE`/`DATA` chunks. Non-streaming banks carry")
    add("their `DATA` inline; streaming banks contain only `WAVE` headers and their")
    add("sample data lives in an external stream. ADPCM is the retail `uADPCM4Bit`")
    add("33-byte/64-sample block decoder, including the retail `mDeltaFader` fade-in and")
    add("the header-frame truncation/padding rule. PCM16 (format 3) is catalogued but not")
    add("decoded. No file in `game-data`, `upstream` or `probes/e1-drive` is modified.")
    add("")
    add("### 2.1 Status semantics")
    add("")
    add("| Status | Meaning |")
    add("| --- | --- |")
    add("| `decoded` | A WAV exists in the manifest with SHA-256 and byte size; it was decoded from the named retail wave. |")
    add("| `decodable` | The retail wave is located in a non-streaming bank with a supported codec, but no WAV was produced (music transitions, ambience, induction/supercharger). |")
    add("| `unsupported` | The wave cannot be decoded in this slice; `reason` is typed: `streaming-container`, `codec-not-implemented`, `bank-or-wave-not-shipped`, `component-not-found`, `graph-not-shipped`. |")
    add("")
    add("A BAF wave has **no serialised UID**. The stable identifier used here is")
    add("`bankName#waveIndex:waveName`, always paired with the bank SHA-256, the")
    add("`dataStart` offset and the `dataLength`. That triple is the provenance key.")
    add("")
    add("## 3. Bank inventory")
    add("")
    add("### 3.1 Totals by family")
    add("")
    add("| Family | Banks | Waves | Loops | Streaming banks |")
    add("| --- | ---: | ---: | ---: | ---: |")
    for f in sorted(fams):
        add(f"| {f} | {fams[f]} | {fam_waves[f]:,} | {fam_loops[f]:,} | {fam_stream[f]} |")
    add(f"| **total** | **{summary['banks']}** | **{summary['waves']:,}** | **{summary['loops']:,}** | **{summary['streamingBanks']}** |")
    add("")
    add("### 3.2 Codec, rate and channel coverage")
    add("")
    add("| Codec | Waves | Decode status |")
    add("| --- | ---: | --- |")
    add(f"| `uADPCM4Bit` (format 7) | {summary['codecs'].get('uADPCM4Bit', 0):,} | decoded where in a non-streaming bank; the decode is the retail block decoder |")
    add(f"| `PCM16` (format 3) | {summary['codecs'].get('PCM16', 0)} | **not implemented**; all four are in streaming banks and are `unsupported/streaming-container` |")
    add("")
    add("| Sample rate | Waves | Notes |")
    add("| --- | ---: | --- |")
    add(f"| 48 kHz | {summary['sampleRates'].get('48000', 0):,} | all UI, wheel, pickups, music, environment and non-AI vehicle banks |")
    add(f"| 36 kHz | {summary['sampleRates'].get('36000', 0):,} | the `*_AI` vehicle banks (27 banks) |")
    add("")
    add(f"Channels: **mono {summary['channels'].get('1', 0):,}**, **stereo {summary['channels'].get('2', 0):,}**.")
    add("All decoded event waves are 48 kHz; stereo waves are interleaved 33-byte")
    add("left/right blocks per 64-sample frame, exactly as `ReadVagStreamStereo`.")
    add("")
    add("### 3.3 Streaming banks")
    add("")
    add("These banks have `BankHeader.streaming = 1` and no inline `DATA` chunks; their")
    add("waves are `unsupported/streaming-container` in this slice.")
    add("")
    add("| Bank | Waves | Bytes |")
    add("| --- | ---: | ---: |")
    for b in sorted((b for b in banks.values() if b["streaming"]), key=lambda x: x["bankName"]):
        add(f"| `{md(b['asset'])}` | {len(b['waves'])} | {b['logicalBytes']:,} |")
    add("")
    add("### 3.4 Full bank table")
    add("")
    add("| Asset | Bank | Pak | Waves | Loops | Rates | Ch | Stream | SHA-256 (first 16) |")
    add("| --- | --- | --- | ---: | ---: | --- | --- | :---: | --- |")
    for key in sorted(banks):
        b = banks[key]
        rates = sorted({w.get("sampleRate") for w in b["waves"] if w.get("sampleRate")})
        chans = sorted({w.get("channels") for w in b["waves"] if w.get("channels")})
        loops = sum(1 for w in b["waves"] if w.get("loop"))
        sha = (b.get("bankSha256") or "header-only")[:16]
        add(f"| `{md(b['asset'])}` | `{md(b['bankName'])}` | `{b['pak']}` | {len(b['waves'])} | {loops} | "
            f"{','.join(str(r) for r in rates)} | {','.join(str(c) for c in chans)} | "
            f"{'yes' if b['streaming'] else 'no'} | `{sha}` |")
    add("")
    add("The full per-wave table (name, index, format, codec, rate, channels, samples,")
    add("loop flag, `dataStart`, `dataLength`) is in `_work/audio/audio-catalog.json`")
    add("under `banks`.")
    add("")
    add("## 4. Entities and graphs")
    add("")
    add("| Group | Entities |")
    add("| --- | ---: |")
    for g, n in sorted(es["groups"].items()):
        add(f"| {g} | {n} |")
    add(f"| **total** | **{es['entities']}** |")
    add("")
    add("`audio.bin` holds 367 `AudioObject` filenames; an `AudioEntityDef` instantiates")
    add("one or more of them. The 365 shipped `.dat` graphs parse without a walk error")
    add(f"in this catalog ({gs['totalSounds']:,} sound components). The earlier")
    add("race-engine component-count anomaly is resolved by the parser's per-component")
    add("size table; no component is guessed.")
    add("")
    add("The event map uses the retail entity name and the retail graph component name as")
    add("the trigger basis. No trigger is invented: every `decoded`/`decodable` row names")
    add("the exact `AudioEntityDef` and `.dat` component that owns the sound.")
    add("")
    add("## 5. Event -> wave table")
    add("")
    add("### 5.1 Coverage by category")
    add("")
    add("| Category | Events | decoded | decodable | unsupported |")
    add("| --- | ---: | ---: | ---: | ---: |")
    for c in sorted(by_cat):
        st = Counter(e["status"] for e in by_cat[c])
        add(f"| {c} | {len(by_cat[c])} | {st.get('decoded', 0)} | {st.get('decodable', 0)} | {st.get('unsupported', 0)} |")
    add(f"| **total** | **{len(events)}** | **{evs['byStatus'].get('decoded', 0)}** | **{evs['byStatus'].get('decodable', 0)}** | **{evs['byStatus'].get('unsupported', 0)}** |")
    add("")
    add("A wave is one row per variant. Multi-wave events list every variant separated")
    add("by `<br>`. `@0x...` is the wave's `dataStart` inside the decoded bank.")
    add("")
    for cat in ("ui", "race", "powerup", "engine", "tyre", "collision", "music", "ambience"):
        rows = by_cat.get(cat, [])
        add(f"### 5.{2 + list(('ui','race','powerup','engine','tyre','collision','music','ambience')).index(cat)} {cat} ({len(rows)} events)")
        add("")
        add("| Event | Entity / graph | Component | Wave / provenance |")
        add("| --- | --- | --- | --- |")
        for e in rows:
            comps = ", ".join(sorted({v.get("component", "") for v in e["variants"]}))
            cell = "<br>".join(variant_cell(v) for v in e["variants"])
            add(f"| `{e['event']}` | `{md(e['entity'])}` / `{md(e['graph'])}` | "
                f"`{md(comps)}` | {cell} |")
        add("")
    add("## 6. Gain, pitch and loop data")
    add("")
    add("The retail sound components expose four options, resolved by")
    add("`Component::GetLevel` / `GetFrequency`:")
    add("")
    add("```text")
    add("effective linear gain = optLevel (linear) * 10^(optGain_dB / 20)   (gain != 0 dB)")
    add("effective rate        = optFrequency (linear) * 2^optPitch (octaves)")
    add("```")
    add("")
    add("An option is **literal** when its `Control.sCom == -1`; otherwise it is driven")
    add("by another component, and the catalog records the control component and, when")
    add("it is a piecewise-linear curve, its points. UI one-shots are literal: their")
    add("decoded `gain` values are shown below. Loops are mostly control-driven, so their")
    add("gain/rate are marked `provisional` in the contract; the decoded curves are in")
    add("`audio-catalog.json` and are listed in §6.2.")
    add("")
    add("### 6.1 Literal UI gains")
    add("")
    add("| Event | Wave | Level (linear) | Gain (dB) | Effective linear |")
    add("| --- | --- | ---: | ---: | ---: |")
    shown = 0
    for e in by_cat.get("ui", []):
        for v in e["variants"]:
            if v.get("status") != "decoded" or v.get("literalGain") is None:
                continue
            opts = v.get("options") or {}
            lvl = opts.get("level", {}).get("fVal")
            gdb = opts.get("gain", {}).get("fVal")
            add(f"| `{e['event']}` | `{md(v['wave'])}` | {lvl} | {gdb} | **{v['literalGain']:.6f}** |")
            shown += 1
    add("")
    add(f"{shown} UI variants have a literal gain. Zero dB is unity; negative values")
    add("are retail attenuation, not a harness choice.")
    add("")
    add("### 6.2 Control-linked curves on decoded event sounds")
    add("")
    add("| Event | Option | Control component | Points (x,y) |")
    add("| --- | --- | --- | --- |")
    seen = set()
    for e in events:
        for v in e["variants"]:
            if v.get("status") != "decoded":
                continue
            for opt, o in (v.get("options") or {}).items():
                ctrl = o.get("control")
                if not ctrl or not ctrl.get("curve"):
                    continue
                key = (e["event"], opt, ctrl["name"], tuple(map(tuple, ctrl["curve"])))
                if key in seen:
                    continue
                seen.add(key)
                pts = ", ".join(f"({x:.6g},{y:.6g})" for x, y in ctrl["curve"])
                add(f"| `{e['event']}` | {opt} | `{md(ctrl['name'])}` | {pts} |")
    add("")
    add("Loop points: the BAF header carries a **loop flag**, not a start/end pair.")
    add("All decoded loops therefore use `loopStart = 0`, `loopEnd = samples`; the")
    add("manifest records both and the verifier checks them. The 66 ms ADPCM fade-in")
    add("is preserved at the loop seam; it is not repaired or crossfaded.")
    add("")
    add("## 7. Decoded manifest")
    add("")
    add("| Measure | Value |")
    add("| --- | ---: |")
    add(f"| Entries | **{man['counts']['total']}** |")
    add(f"| Newly decoded | {man['counts']['newlyDecoded']} |")
    add(f"| Reused existing | {man['counts']['existingDecoded']} |")
    add(f"| Loops / one-shots | {man['counts']['loops']} / {man['counts']['oneShots']} |")
    add(f"| Total bytes | **{fmt_bytes(man['bytes']['total'])}** |")
    add(f"| New bytes | {fmt_bytes(man['bytes']['newlyDecoded'])} |")
    add(f"| Reused bytes | {fmt_bytes(man['bytes']['existingDecoded'])} |")
    add(f"| Codecs | {', '.join(f'{k} {v}' for k, v in man['codecs'].items())} |")
    add(f"| Rates | {', '.join(f'{k} Hz {v}' for k, v in man['sampleRates'].items())} |")
    add(f"| Channels | {', '.join(f'{k} ch {v}' for k, v in man['channels'].items())} |")
    add("")
    add("Per-category byte cost of the decoded event set (a wave shared by two events is")
    add("counted once per category that references it):")
    add("")
    cat_bytes = Counter()
    cat_count = Counter()
    uid_cats = {}
    for e in events:
        for v in e["variants"]:
            if v.get("status") == "decoded":
                uid_cats.setdefault(v["waveUid"], set()).add(e["category"])
    for m in man["entries"]:
        for c in uid_cats.get(m["waveUid"], {"(unreferenced)"}):
            cat_bytes[c] += m["bytes"]
            cat_count[c] += 1
    add("| Category | Entries | Bytes |")
    add("| --- | ---: | ---: |")
    for c in sorted(cat_bytes):
        add(f"| {c} | {cat_count[c]} | {fmt_bytes(cat_bytes[c])} |")
    add("")
    add("### 7.1 File hashes")
    add("")
    add("| File | Bytes | SHA-256 |")
    add("| --- | ---: | --- |")
    for name in ("audio-catalog.json", "audio-manifest.json", "integration-contract.json", "audio-catalog-verify.json"):
        p = OUT / name
        if p.exists():
            import hashlib
            add(f"| `_work/audio/{name}` | {p.stat().st_size:,} | `{hashlib.sha256(p.read_bytes()).hexdigest()}` |")
    add("")
    add("Per-wave hashes are in `audio-manifest.json` and in the table below. The verifier")
    add("re-decodes every entry twice and requires both runs to be byte-identical to the")
    add("stored file, so these hashes are reproducible from the retail banks.")
    add("")
    add("### 7.2 Full manifest table")
    add("")
    add("| Wave UID | File | Offset | Bytes | SHA-256 | Loop | Duration | Source |")
    add("| --- | --- | ---: | ---: | --- | :---: | ---: | --- |")
    for m in man["entries"]:
        add(f"| `{md(m['waveUid'])}` | `{md(m['file'])}` | 0x{m['dataStart']:x} | {m['bytes']:,} | "
            f"`{m['sha256']}` | {'loop' if m['loop'] else '—'} | {m.get('durationSeconds', 0)} s | {m['source']} |")
    add("")
    add("## 8. Integration contract for the web consumer")
    add("")
    add("`_work/audio/integration-contract.json` is the machine-readable contract. It")
    add("contains one entry per decoded event:")
    add("")
    add("```json")
    add('{')
    add('  "event": "ui.navigate.forward",')
    add('  "category": "ui", "entity": "FrontEndUI", "graph": "FrontEndUI.dat",')
    add('  "bus": "ui", "priority": 90, "duckGroup": "music", "priorityProvisional": true,')
    add('  "variants": [{')
    add('    "file": "_work/audio/catalog/wav/FrontEndUI/FE_Forward.wav",')
    add('    "sha256": "...", "bytes": 100268, "waveUid": "FrontEndUI:7:FE_Forward",')
    add('    "loop": false, "loopStart": 0, "loopEnd": null,')
    add('    "gainLinear": 0.794328, "gainDb": -2.0, "gainProvisional": false,')
    add('    "frequency": 1.0, "pitchOctaves": 0.0, "rate": 1.0, "rateProvisional": false,')
    add('    "bank": "FrontEndUI", "wave": "FE_Forward"')
    add('  }],')
    add('  "provenance": {"basis": "retail AudioEntityDef name + audio graph component name",')
    add('                  "entityRefId": 578343422, "graph": "FrontEndUI.dat"}')
    add('}')
    add("```")
    add("")
    add("Rules:")
    add("")
    add("1. Play only files whose SHA-256 matches the contract. If a file is missing or")
    add("   the hash differs, stay silent and report `fetch-failed`/`decode-failed`.")
    add("2. `gainLinear`/`gainDb` are retail-derived only when `gainProvisional:false`;")
    add("   otherwise apply `1.0` as a neutral placeholder and mark the value provisional")
    add("   in diagnostics. Do not invent a retail gain.")
    add("3. `rate` is `optFrequency * 2^optPitch`; when `rateProvisional:true`, use")
    add("   `1.0` and expose the decoded control curve if the page wants to drive it.")
    add("4. Loops start at `loopStart` and end at `loopEnd`. One-shots are not looped.")
    add("5. `priority` and `duckGroup` are **integration choices**, not decoded retail")
    add("   values; every group is marked `provisional:true`. A simple starting mix is:")
    add("   UI 90, race/HUD 80, power-up 70, collision 60, engine 50, tyre 40, music 20,")
    add("   ambience 10; UI/race duck music.")
    add("6. Unsupported events are listed under `unsupported` with a typed reason. The")
    add("   page must not substitute another wave.")
    add("")
    add("### 8.1 Contract event table")
    add("")
    add("| Event | File | Loop | Gain (linear) | Rate | Bus | Priority | Duck | Provisional |")
    add("| --- | --- | :---: | ---: | ---: | --- | ---: | --- | :---: |")
    for name in sorted(contract["events"]):
        e = contract["events"][name]
        for v in e["variants"]:
            gain = "—" if v["gainLinear"] is None else f"{v['gainLinear']:.6f}"
            prov = "gain" if v["gainProvisional"] else ("rate" if v["rateProvisional"] else "no")
            add(f"| `{name}` | `{md(v['file'])}` | {'yes' if v['loop'] else 'no'} | {gain} | "
                f"{v['rate']:.6f} | {e['bus']} | {e['priority']} | {e['duckGroup'] or '—'} | {prov} |")
    add("")
    add("### 8.2 Unsupported events")
    add("")
    add("| Event | Status | Reason |")
    add("| --- | --- | --- |")
    for name in sorted(contract["unsupported"]):
        u = contract["unsupported"][name]
        add(f"| `{name}` | {u['status']} | `{u.get('reason')}` |")
    add("")
    add("## 9. Verification")
    add("")
    add(f"`python probes/audio/verify_audio_catalog.py` -> **{verify['checks']:,} checks,")
    add(f"{verify['passed']:,} passed, {verify['failed']} failed**.")
    add("")
    add("The checks include:")
    add("")
    add("- bank inventory totals, every wave's bounds/codec/rate/channels and loop flag;")
    add("- entity/group/object counts and every entity->graph reference;")
    add("- graph parse coverage and every sound component's bank/wave list;")
    add("- every event's status, variant status, typed unsupported reason and coverage;")
    add("- every manifest entry's provenance, file existence, byte size, SHA-256, loop")
    add("  sanity, codec/rate/channel sanity and data offset;")
    add("- **two independent decodes per entry**, both byte-identical to the stored WAV;")
    add("- size accounting (`new + reused = total`, entry sum = reported total);")
    add("- no duplicate UID/file hash conflicts;")
    add("- integration-contract files, gains, rates and loop fields.")
    add("")
    add("Determinism: the manifest is rebuilt from the retail PAK bytes each run; the")
    add("verifier decodes each entry twice and compares the WAV hashes to the file. A")
    add("second catalog run produces the same `audio-manifest.json` bytes.")
    add("")
    add("## 10. Limits and non-claims")
    add("")
    add("1. **Streaming music is not decoded.** 70 music events are")
    add("   `unsupported/streaming-container`: `MenuMusic`, `InGameMusic`,")
    add("   `InGameCustomMusic`, `VistaMusic`, and the `ENV_*_ST`/`ENV_Battle`/")
    add("   `ENV_Fireworks` banks. Their `WAVE` headers are catalogued; the sample")
    add("   data is external and no WAV is produced.")
    add("2. **PCM16 is not decoded.** Four sync loops in streaming banks use format 3.")
    add("   They are `unsupported/streaming-container` before the codec question")
    add("   matters; no PCM16 WAV is claimed.")
    add("3. **Ambience is catalogued, not decoded.** 38 `AMB_*` entities and their")
    add("   graphs/waves are `decodable`; their banks are mostly non-streaming")
    add("   environment banks. They are left out of the manifest to keep it focused.")
    add("4. **Not the retail mixer.** Priority, ducking, sends/returns, EQ, occlusion,")
    add("   cone, rolloff, the retail limiter and the Ovis graph runtime are not")
    add("   reproduced. The contract marks integration choices `provisional`.")
    add("5. **Retail gain is only literal for some one-shots.** Most loops have a")
    add("   control-driven level/frequency; their curve points are recorded, but the")
    add("   page must either apply the curve or use a documented neutral placeholder.")
    add("6. **No engine-run or multi-car mix claim.** Six `Race_V8` RPM loops are")
    add("   reused from P62/P71. The other 53 vehicle banks are catalogued but not")
    add("   mapped to a car roster; AI banks are 36 kHz.")
    add("7. **No car-to-bank roster claim.** The entity list names `Race_V8`, `Chevy_V8`,")
    add("   `Ford_i5`, etc.; the E1 car mapping remains a separate task.")
    add("8. **No full-game audio claim.** This catalog covers bank/entity/event")
    add("   provenance and the practical UI/race/power-up set, not every retail")
    add("   behaviour.")
    add("9. **Decoded WAVs are game data.** They live under `_work/audio/` and are not")
    add("   committed. A shipped build needs its own asset pipeline or a wasm ADPCM")
    add("   decoder.")
    add("10. **No browser capture in this task.** The existing E1 audio integration is")
    add("    untouched; this catalog is data/provenance only.")
    add("")
    add("## 11. Reproduction")
    add("")
    add("```powershell")
    add('cd "C:\\Users\\ismailemin\\Documents\\Blur Web"')
    add('$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"')
    add("")
    add("# 1. Build the catalog, manifest and contract (reads PAKs, writes _work only)")
    add("& $py probes/audio/audio_catalog.py")
    add("")
    add("# 2. Verify (>=250 checks; two decode runs per manifest entry)")
    add("& $py probes/audio/verify_audio_catalog.py")
    add("")
    add("# 3. Re-render this document from the JSON evidence")
    add("& $py probes/audio/render_audio_catalog_doc.py")
    add("```")
    add("")
    add("## 12. Evidence index")
    add("")
    add("| Path | What |")
    add("| --- | --- |")
    add("| `_work/audio/audio-catalog.json` | 193 banks, 2,732 waves, 228 entities, 365 graphs, 334 events, per-wave provenance |")
    add("| `_work/audio/audio-manifest.json` | 220 decoded/reused entries with SHA-256, bytes, loop and duration |")
    add("| `_work/audio/integration-contract.json` | Event -> file/loop/gain/rate/bus/priority/ducking |")
    add("| `_work/audio/audio-catalog-verify.json` | 20,613-check verifier report |")
    add("| `_work/audio/catalog/graphs/` | Decoded `.dat` copies (365) |")
    add("| `_work/audio/catalog/wav/` | 160 newly decoded WAVs, grouped by bank |")
    add("| `_work/logs/audio/catalog-run*.log` | Catalog build logs |")
    add("| `_work/logs/audio/verify-full1.log` | Full verifier output |")
    add("| `_work/logs/audio/docdata.log` | Summary numbers used by this document |")
    add("")
    add("No game data, decoded fixture or generated WASM is committed. The decoded")
    add("WAVs, `.dat`/`.baf` copies and logs live under `_work/` only.")
    add("")

    DOC.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"wrote {DOC} ({DOC.stat().st_size:,} bytes, {len(lines)} lines)")


if __name__ == "__main__":
    main()
