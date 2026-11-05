"""T-006b net-layout probe — build native + wasm32, run, compare, record.

    python probes/net-layout/tests/run_net_layout.py
    python probes/net-layout/tests/run_net_layout.py --skip-build
    python probes/net-layout/tests/run_net_layout.py --native-only

Three targets are measured:

    native-msvc-x64       MSVC x64 Release, wchar_t = 2   (the reference ABI)
    wasm32-default        em++ -O2,           wchar_t = 4 (current/today's wasm ABI)
    wasm32-short-wchar    em++ -O2 -fshort-wchar, wchar_t = 2 (the mitigation)

Each target's JSON is compared against an independent Python model of the same
declarations (tests/reference_layout.py), so a shared wrong assumption between
the two C++ builds is caught. The native and -fshort-wchar layouts must be
identical; the default wasm32 layout must differ only in the wchar_t-bearing
types.

Outputs: _work/net-layout/*.json, _work/net-layout/layout-table.md,
         _work/logs/net-layout/*.log
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
PROBE = ROOT / 'probes' / 'net-layout'
OUT = ROOT / '_work' / 'net-layout'
LOGS = ROOT / '_work' / 'logs' / 'net-layout'
GOLDEN = OUT / 'golden'
NATIVE_BUILD = ROOT / '_work' / 'build' / 'net-layout-native'
WASM_BUILD = OUT / 'build'
EMSDK = ROOT / '_work' / 'toolchains' / 'emsdk'

# Fixture name -> (native byte length, carries a wchar_t-dependent field).
# The second flag is what the negative test keys on: a fixture that embeds a
# name must fail the raw-struct path on wasm, and join_data (no wchar_t) must
# not, which keeps the negative test honest.
GOLDEN_EXPECTED = {
    'base_profile': (56, True),
    'start_race_player': (104, True),
    'start_race': (2104, True),
    'join_request_1local': (125, True),
    'join_reply_host_1local': (117, True),
    'join_data_host_0peers': (85, False),
}

WASM_FLAGS = [
    '-std=c++17', '-O2', '-Wall', '-Wextra', '-Wpedantic',
    # The probe's own copy of the declarations triggers two diagnostics that are
    # artifacts of copying an engine header into an engine-free probe:
    #   -Winvalid-offsetof : offsetof on the non-standard-layout types, guarded
    #                        by `if constexpr` and discarded, but clang still
    #                        parses the discarded branch;
    #   -Wreorder-ctor     : the upstream constructor initialiser order differs
    #                        from declaration order (harmless, copied verbatim).
    '-Wno-invalid-offsetof', '-Wno-reorder-ctor',
    '-sMODULARIZE=1', '-sEXPORT_ES6=1', '-sENVIRONMENT=node,web',
    '-sALLOW_MEMORY_GROWTH=0', '-sINITIAL_MEMORY=16777216', '--no-entry',
    '-sEXPORTED_FUNCTIONS=_wire_layout_json,_wire_layout_selftest',
    '-sEXPORTED_RUNTIME_METHODS=UTF8ToString',
]

CHECKS: list[tuple[str, bool, str]] = []


def record(name: str, ok: bool, detail: str = '') -> None:
    CHECKS.append((name, bool(ok), detail))
    status = 'PASS' if ok else 'FAIL'
    line = f'{name}: {status}'
    if detail:
        line += f'  {detail}'
    print(line)


def run(cmd: list[str], log: Path, cwd: Path | None = None) -> None:
    log.parent.mkdir(parents=True, exist_ok=True)
    with log.open('w', encoding='utf-8') as f:
        f.write('$ ' + ' '.join(cmd) + '\n\n')
        f.flush()
        proc = subprocess.run(cmd, cwd=cwd or ROOT, stdout=subprocess.PIPE,
                              stderr=subprocess.STDOUT, text=True)
        f.write(proc.stdout)
    if proc.returncode != 0:
        tail = '\n'.join(proc.stdout.splitlines()[-25:])
        raise RuntimeError(f'command failed ({proc.returncode}): {" ".join(cmd)}\n{tail}')


def cmake_path() -> Path:
    query = Path(os.environ.get('ProgramFiles(x86)', 'C:/Program Files (x86)')) / \
        'Microsoft Visual Studio/Installer/vswhere.exe'
    location = subprocess.check_output(
        [str(query), '-latest', '-products', '*',
         '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
         '-property', 'installationPath'], text=True).strip()
    if not location:
        raise RuntimeError('Visual Studio C++ build tools not found')
    return Path(location) / 'Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe'


def build_native() -> None:
    cmake = cmake_path()
    run([str(cmake), '-S', str(PROBE), '-B', str(NATIVE_BUILD),
         '-G', 'Visual Studio 17 2022', '-A', 'x64'], LOGS / 'cmake-configure.log')
    run([str(cmake), '--build', str(NATIVE_BUILD), '--config', 'Release'],
        LOGS / 'build-native.log')
    ctest = cmake.with_name('ctest.exe')
    run([str(ctest), '--test-dir', str(NATIVE_BUILD), '-C', 'Release',
         '--output-on-failure'], LOGS / 'ctest-native.log')


def build_wasm(label: str, short_wchar: bool) -> Path:
    emxx = EMSDK / 'upstream' / 'emscripten' / 'em++.py'
    if not emxx.exists():
        raise RuntimeError(f'emsdk not found at {EMSDK}')
    out = WASM_BUILD / f'net_layout_{label}.mjs'
    cmd = [sys.executable, str(emxx),
           str(PROBE / 'src' / 'probe_core.cpp'), str(PROBE / 'src' / 'wire_encoder.cpp'),
           str(PROBE / 'src' / 'wasm_entry.cpp'),
           f'-DWIRE_PROBE_FLAGS={label}']
    cmd += WASM_FLAGS
    if short_wchar:
        cmd.append('-fshort-wchar')
    cmd += ['-o', str(out)]
    run(cmd, LOGS / f'build-wasm-{label}.log')
    return out


def run_native(out_path: Path) -> dict:
    exe = NATIVE_BUILD / 'Release' / 'net_layout_probe.exe'
    run([str(exe), '--selftest'], LOGS / 'run-native-selftest.log')
    run([str(exe), '--out', str(out_path)], LOGS / 'run-native.log')
    return json.loads(out_path.read_text(encoding='utf-8'))


def run_wasm(module: Path, out_path: Path, label: str) -> dict:
    run(['node', str(PROBE / 'tests' / 'verify_net_layout.mjs'),
         str(module), str(out_path)], LOGS / f'run-wasm-{label}.log')
    return json.loads(out_path.read_text(encoding='utf-8'))


def run_reference(wchar: int, abi: str, out_path: Path) -> dict:
    run([sys.executable, str(PROBE / 'tests' / 'reference_layout.py'),
         '--wchar', str(wchar), '--abi', abi, '--out', str(out_path)],
        LOGS / f'reference-{abi}-wchar{wchar}.log')
    return json.loads(out_path.read_text(encoding='utf-8'))


# ---------------------------------------------------------------------------
# comparison
# ---------------------------------------------------------------------------
def normalise(doc: dict) -> dict:
    """Layer of a layout document that must be comparable across targets."""
    types = {}
    for t in doc['types']:
        types[t['name']] = {
            'size': t['size'],
            'align': t['align'],
            'fields': {f['name']: (f['offset'], f['size'], f['count']) for f in t['fields']},
            'bitfields': {b['name']: (b['firstBit'], b['width'], b['spanBytes'])
                          for b in t.get('bitfields', [])},
            'padding': list(t['paddingOffsets']),
        }
    records = {r['name']: r['size'] for r in doc['records']}
    return {'types': types, 'records': records}


def diff_layout(expected: dict, actual: dict) -> list[str]:
    """Compare two normalised layouts; returns human-readable differences."""
    problems: list[str] = []
    e_types, a_types = expected['types'], actual['types']
    for name in e_types:
        if name not in a_types:
            problems.append(f'{name}: missing')
            continue
        e, a = e_types[name], a_types[name]
        for key in ('size', 'align', 'padding'):
            if e[key] != a[key]:
                problems.append(f'{name}.{key}: expected {e[key]}, got {a[key]}')
        for fname, val in e['fields'].items():
            if fname not in a['fields']:
                problems.append(f'{name}.{fname}: missing')
            elif a['fields'][fname] != val:
                problems.append(f'{name}.{fname}: expected {val}, got {a["fields"][fname]}')
        for bname, val in e['bitfields'].items():
            if bname not in a['bitfields']:
                problems.append(f'{name}.{bname}: missing')
            elif a['bitfields'][bname] != val:
                problems.append(f'{name}.{bname}: expected {val}, got {a["bitfields"][bname]}')
    for name in a_types:
        if name not in e_types:
            problems.append(f'{name}: unexpected type')
    for name, size in expected['records'].items():
        if name not in actual['records']:
            problems.append(f'record {name}: missing')
        elif actual['records'][name] != size:
            problems.append(f'record {name}: expected {size}, got {actual["records"][name]}')
    return problems


def wchar_dependent() -> list[str]:
    """Types whose layout contains a wchar_t array (directly or by value)."""
    return [
        'SysProfile::BaseProfile',
        'RacerNet::NetStartRacePacketPlayer',
        'RacerNet::NetStartRacePacket',
    ]


def describe_delta(small: dict, big: dict) -> dict:
    types, records = [], []
    for name, t in small['types'].items():
        other = big['types'].get(name)
        if other is None:
            continue
        field_delta = []
        for fname, val in t['fields'].items():
            oval = other['fields'].get(fname)
            if oval is not None and oval != val:
                field_delta.append({
                    'field': fname,
                    'offsetSmall': val[0],
                    'offsetBig': oval[0],
                    'delta': oval[0] - val[0],
                    'sizeSmall': val[1],
                    'sizeBig': oval[1],
                })
        if t['size'] != other['size'] or t['align'] != other['align'] or field_delta or \
                t['padding'] != other['padding'] or t['bitfields'] != other['bitfields']:
            types.append({
                'type': name,
                'sizeSmall': t['size'],
                'sizeBig': other['size'],
                'sizeDelta': other['size'] - t['size'],
                'alignSmall': t['align'],
                'alignBig': other['align'],
                'fields': field_delta,
                'paddingSmall': t['padding'],
                'paddingBig': other['padding'],
                'bitfieldsEqual': t['bitfields'] == other['bitfields'],
            })
    for name, size in small['records'].items():
        if big['records'].get(name, size) != size:
            records.append({
                'record': name,
                'sizeSmall': size,
                'sizeBig': big['records'][name],
                'delta': big['records'][name] - size,
            })
    return {'types': types, 'records': records}


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    h.update(path.read_bytes())
    return h.hexdigest()


# ---------------------------------------------------------------------------
# golden fixtures (explicit encoder)
# ---------------------------------------------------------------------------
def golden_map(doc: dict) -> dict[str, dict]:
    return {f['name']: f for f in doc.get('golden', {}).get('fixtures', [])}


def write_golden_fixtures(native: dict) -> dict:
    """Materialise the native encoder output as .bin + banner .json files."""
    GOLDEN.mkdir(parents=True, exist_ok=True)
    entries = []
    for f in native['golden']['fixtures']:
        blob = bytes.fromhex(f['hex'])
        bin_path = GOLDEN / f"{f['name']}.bin"
        bin_path.write_bytes(blob)
        digest = hashlib.sha256(blob).hexdigest()
        banner = {
            'schema': 'blur-wire-golden-fixture/1',
            'case': f['name'],
            'kind': f['kind'],
            'source': native['golden']['source'],
            'upstream_commit': native['upstreamCommit'],
            'encoder': native['golden']['encoder'],
            'scope': native['golden']['scope'],
            'length': len(blob),
            'sha256': digest,
            'fnv1a64': f['fnv1a64'],
            'wchar_dependent': f['wcharDependent'],
            'raw_variant': f['rawVariant'],
            'file': bin_path.name,
        }
        (GOLDEN / f"{f['name']}.json").write_text(
            json.dumps(banner, indent=2) + '\n', encoding='utf-8')
        entries.append({
            'name': f['name'],
            'file': bin_path.relative_to(ROOT).as_posix(),
            'banner': (GOLDEN / f"{f['name']}.json").relative_to(ROOT).as_posix(),
            'size': len(blob),
            'sha256': digest,
            'fnv1a64': f['fnv1a64'],
            'wcharDependent': f['wcharDependent'],
        })

    manifest = {
        'schema': 'blur-wire-golden-manifest/1',
        'source': native['golden']['source'],
        'upstreamCommit': native['upstreamCommit'],
        'encoder': native['golden']['encoder'],
        'scope': native['golden']['scope'],
        'namePolicy': native['golden']['namePolicy'],
        'startRacePolicy': native['golden']['startRacePolicy'],
        'fixtures': entries,
    }
    manifest_path = GOLDEN / 'manifest.json'
    manifest_path.write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    return {'manifest': manifest_path.relative_to(ROOT).as_posix(),
            'manifestSha256': sha256(manifest_path), 'fixtures': entries}


def check_golden(native: dict, native_second: dict, wasm4: dict | None,
                 wasm2: dict | None) -> dict:
    gn = golden_map(native)
    names = sorted(gn)
    record('golden-fixtures-present', names == sorted(GOLDEN_EXPECTED),
           f'{len(names)} fixtures: {names}')

    bad_size = [n for n, (size, _) in GOLDEN_EXPECTED.items()
                if n in gn and gn[n]['size'] != size]
    record('golden-sizes-match-native-contract', not bad_size,
           f'expected {[s for s, _ in GOLDEN_EXPECTED.values()]}, '
           f'got {[gn[n]["size"] for n in names]}'
           + (f'; bad: {bad_size}' if bad_size else ''))

    bad_hash = []
    for n, f in gn.items():
        try:
            blob = bytes.fromhex(f['hex'])
        except ValueError:
            bad_hash.append(n)
            continue
        if len(blob) != f['size'] or hashlib.sha256(blob).hexdigest() != f['sha256']:
            bad_hash.append(n)
    record('golden-sha256-matches-bytes', not bad_hash,
           '' if not bad_hash else f'differ: {bad_hash}')

    record('golden-deterministic-across-runs',
           native.get('golden') == native_second.get('golden'),
           'native run 1 vs run 2')

    dependent = [n for n, (_, dep) in GOLDEN_EXPECTED.items() if dep]
    native_raw_bad = [n for n in dependent
                      if not gn[n]['rawVariant']['matchesGolden']]
    record('native-raw-equals-golden', not native_raw_bad,
           f'raw sizes {[gn[n]["rawVariant"]["size"] for n in dependent]}'
           + (f'; differ: {native_raw_bad}' if native_raw_bad else ''))

    if wasm4 is not None and wasm2 is not None:
        g4, g2 = golden_map(wasm4), golden_map(wasm2)

        def encoder_equal(other: dict[str, dict]) -> bool:
            return all(n in other and other[n]['hex'] == gn[n]['hex']
                       and other[n]['sha256'] == gn[n]['sha256'] for n in names)

        record('wasm-default-encoder-matches-native', encoder_equal(g4),
               f'wchar_t={wasm4["build"]["wcharBytes"]}')
        record('wasm-short-wchar-encoder-matches-native', encoder_equal(g2),
               f'wchar_t={wasm2["build"]["wcharBytes"]}')

        default_raw_same = [n for n in dependent if g4[n]['rawVariant']['matchesGolden']]
        record('wasm-default-raw-differs-on-wchar-fixtures', not default_raw_same,
               'raw sizes ' + str([g4[n]['rawVariant']['size'] for n in dependent])
               + (f'; unexpectedly equal: {default_raw_same}' if default_raw_same else ''))

        short_raw_same = [n for n in dependent if g2[n]['rawVariant']['matchesGolden']]
        record('wasm-short-wchar-raw-differs-on-wchar-fixtures', not short_raw_same,
               'raw sizes ' + str([g2[n]['rawVariant']['size'] for n in dependent])
               + (f'; unexpectedly equal: {short_raw_same}' if short_raw_same else ''))

        # Positive control: a record with no wchar_t-dependent field is safe on
        # the raw path, so the negative checks above are not vacuous.
        control = 'join_data_host_0peers'
        ok_control = (gn[control]['rawVariant']['matchesGolden']
                      and g4[control]['rawVariant']['matchesGolden']
                      and g2[control]['rawVariant']['matchesGolden'])
        record('wchar-free-record-raw-is-identical', ok_control,
               f'{control} raw == golden on native, wasm4 and wasm2')

    written = write_golden_fixtures(native)
    written_ok = all(
        (ROOT / e['file']).stat().st_size == e['size']
        and sha256(ROOT / e['file']) == e['sha256']
        for e in written['fixtures'])
    record('golden-fixtures-written', written_ok,
           f'{len(written["fixtures"])} .bin + banner .json, manifest '
           f'{written["manifestSha256"][:16]}…')
    return written


def markdown_table(native: dict, wasm4: dict) -> str:
    n = normalise(native)
    w = normalise(wasm4)
    lines = [
        '| type | native size/align | wasm4 size/align | delta | padding bytes (native) | poison |',
        '| --- | ---: | ---: | ---: | --- | --- |',
    ]
    poison = {t['name']: t['poisonSensitive'] for t in native['types']}
    for name, t in n['types'].items():
        other = w['types'][name]
        pad = ' '.join(str(p) for p in t['padding']) if t['padding'] else '—'
        delta = other['size'] - t['size']
        lines.append(f'| `{name}` | {t["size"]}/{t["align"]} | {other["size"]}/{other["align"]} | '
                     f'{delta:+d} | {pad} | {"yes" if poison[name] else "no"} |')
    lines += [
        '',
        '| record | native bytes | wasm4 bytes | delta |',
        '| --- | ---: | ---: | ---: |',
    ]
    for name, size in n['records'].items():
        other = w['records'][name]
        lines.append(f'| `{name}` | {size} | {other} | {other - size:+d} |')
    return '\n'.join(lines) + '\n'


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--skip-build', action='store_true')
    parser.add_argument('--native-only', action='store_true')
    args = parser.parse_args()

    OUT.mkdir(parents=True, exist_ok=True)
    LOGS.mkdir(parents=True, exist_ok=True)
    WASM_BUILD.mkdir(parents=True, exist_ok=True)

    # Transcription gate first: the declarations the probe measures must still be
    # the ones in the committed upstream tree.
    try:
        run([sys.executable, str(PROBE / 'tests' / 'check_decls.py')],
            LOGS / 'check-decls.log')
        decl_log = (LOGS / 'check-decls.log').read_text(encoding='utf-8')
        record('declarations-match-upstream', True, decl_log.strip().splitlines()[-1])
    except RuntimeError as exc:
        record('declarations-match-upstream', False, str(exc).splitlines()[0])

    native_path = OUT / 'native.json'
    wasm4_path = OUT / 'wasm-default.json'
    wasm2_path = OUT / 'wasm-short-wchar.json'

    if not args.skip_build:
        build_native()
        if not args.native_only:
            build_wasm('wasm32-default-wchar4', short_wchar=False)
            build_wasm('wasm32-short-wchar2', short_wchar=True)

    native = run_native(native_path)
    record('native-selftest', True)

    # determinism: a second run must produce the same file
    native2_path = OUT / 'native-second.json'
    native2 = run_native(native2_path)
    record('native-deterministic', native_path.read_bytes() == native2_path.read_bytes(),
           f'sha256 {sha256(native_path)[:16]}…')

    ref2 = run_reference(2, 'msvc', OUT / 'reference-msvc-wchar2.json')

    problems = diff_layout(normalise(ref2), normalise(native))
    record('native-vs-reference(msvc,wchar2)', not problems,
           '' if not problems else f'{len(problems)} differences, first: {problems[0]}')

    if args.native_only:
        check_golden(native, native2, None, None)
        return summarise(CHECKS, args)

    wasm4 = run_wasm(WASM_BUILD / 'net_layout_wasm32-default-wchar4.mjs', wasm4_path, 'default')
    wasm2 = run_wasm(WASM_BUILD / 'net_layout_wasm32-short-wchar2.mjs', wasm2_path, 'short')

    # determinism of the wasm path: the same module twice, byte-compared
    wasm4_again = OUT / 'wasm-default-second.json'
    wasm2_again = OUT / 'wasm-short-wchar-second.json'
    run_wasm(WASM_BUILD / 'net_layout_wasm32-default-wchar4.mjs', wasm4_again, 'default')
    run_wasm(WASM_BUILD / 'net_layout_wasm32-short-wchar2.mjs', wasm2_again, 'short')
    record('wasm-default-deterministic', wasm4_path.read_bytes() == wasm4_again.read_bytes(),
           f'sha256 {sha256(wasm4_path)[:16]}…')
    record('wasm-short-wchar-deterministic', wasm2_path.read_bytes() == wasm2_again.read_bytes(),
           f'sha256 {sha256(wasm2_path)[:16]}…')

    ref4 = run_reference(4, 'itanium', OUT / 'reference-itanium-wchar4.json')
    ref2i = run_reference(2, 'itanium', OUT / 'reference-itanium-wchar2.json')
    problems = diff_layout(normalise(ref4), normalise(wasm4))
    record('wasm-default-vs-reference(itanium,wchar4)', not problems,
           '' if not problems else f'{len(problems)} differences, first: {problems[0]}')
    problems = diff_layout(normalise(ref2i), normalise(wasm2))
    record('wasm-short-wchar-vs-reference(itanium,wchar2)', not problems,
           '' if not problems else f'{len(problems)} differences, first: {problems[0]}')

    # What the wchar mitigation actually buys. -fshort-wchar makes the name 34
    # bytes on wasm, so the wchar_t width delta disappears -- but Emscripten
    # also reuses the base-class tail padding (dsize rule) where MSVC does not,
    # so BaseProfile still lands at 48 instead of 56.
    delta_short = describe_delta(normalise(native), normalise(wasm2))
    changed_short = sorted(t['type'] for t in delta_short['types'])
    name_short = {f['name']: f for t in wasm2['types'] if t['name'] == 'SysProfile::BaseProfile'
                  for f in t['fields']}
    name_native = {f['name']: f for t in native['types'] if t['name'] == 'SysProfile::BaseProfile'
                   for f in t['fields']}
    record('short-wchar-name-is-34-bytes',
           name_short['m_Name']['size'] == name_native['m_Name']['size'] == 34,
           f'wasm {name_short["m_Name"]["size"]} B, native {name_native["m_Name"]["size"]} B')
    record('short-wchar-still-shifts-base-class-types',
           changed_short == sorted(wchar_dependent()),
           f'changed: {changed_short}')
    base_delta = next(t for t in delta_short['types'] if t['type'] == 'SysProfile::BaseProfile')
    record('short-wchar-base-offset-delta-is-6',
           next(f['delta'] for f in base_delta['fields'] if f['field'] == 'm_Name') == -6,
           f'm_Name offset delta {next(f["delta"] for f in base_delta["fields"] if f["field"] == "m_Name")}')

    # The default wasm ABI differs for the same three types, and only those.
    delta = describe_delta(normalise(native), normalise(wasm4))
    changed_types = sorted(t['type'] for t in delta['types'])
    record('default-wasm-delta-is-wchar-scope', changed_types == sorted(wchar_dependent()),
           f'changed types: {changed_types}')

    changed_records = sorted(r['record'] for r in delta['records'])
    expected_records = sorted([
        'join_request_1local',
        'join_reply_host_1local',
        'start_race_packet',
    ])
    record('default-wasm-record-delta-is-wchar-scope', changed_records == expected_records,
           f'changed records: {changed_records}')

    # Canonical byte images: identical for every type that carries no wchar_t.
    native_images = {t['name']: t['canonicalHash'] for t in native['types']}
    wasm2_images = {t['name']: t['canonicalHash'] for t in wasm2['types']}
    wasm4_images = {t['name']: t['canonicalHash'] for t in wasm4['types']}
    image_diff = [n for n in native_images
                  if n not in wchar_dependent() and native_images[n] != wasm2_images.get(n)]
    record('wchar-free-types-have-identical-canonical-bytes', not image_diff,
           '' if not image_diff else f'differ: {image_diff[:3]}')
    image_diff4 = [n for n in native_images
                   if n not in wchar_dependent() and native_images[n] != wasm4_images.get(n)]
    record('wchar-free-types-identical-on-default-wasm-too', not image_diff4,
           '' if not image_diff4 else f'differ: {image_diff4[:3]}')

    # wchar_t width really is what we think it is.
    record('native-wchar-2', native['build']['wcharBytes'] == 2, str(native['build']['wcharBytes']))
    record('wasm-default-wchar-4', wasm4['build']['wcharBytes'] == 4, str(wasm4['build']['wcharBytes']))
    record('wasm-short-wchar-2', wasm2['build']['wcharBytes'] == 2, str(wasm2['build']['wcharBytes']))

    native_n = normalise(native)
    golden_written = check_golden(native, native2, wasm4, wasm2)
    table = markdown_table(native, wasm4)
    (OUT / 'layout-table.md').write_text(table, encoding='utf-8')

    summary = {
        'schema': 'blur-wire-layout-summary/1',
        'targets': {
            'native': {'json': str(native_path.relative_to(ROOT)), 'sha256': sha256(native_path),
                       'build': native['build']},
            'wasmDefault': {'json': str(wasm4_path.relative_to(ROOT)), 'sha256': sha256(wasm4_path),
                            'build': wasm4['build']},
            'wasmShortWchar': {'json': str(wasm2_path.relative_to(ROOT)), 'sha256': sha256(wasm2_path),
                               'build': wasm2['build']},
        },
        'reference': {
            'msvcWchar2': str((OUT / 'reference-msvc-wchar2.json').relative_to(ROOT)),
            'itaniumWchar4': str((OUT / 'reference-itanium-wchar4.json').relative_to(ROOT)),
            'itaniumWchar2': str((OUT / 'reference-itanium-wchar2.json').relative_to(ROOT)),
        },
        'nativeLayout': native_n,
        'wcharDeltaDefaultWasm': delta,
        'wcharDeltaShortWchar': delta_short,
        'golden': golden_written,
        'checks': [{'name': n, 'pass': ok, 'detail': d} for n, ok, d in CHECKS],
    }
    (OUT / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n', encoding='utf-8')

    print()
    print(table)
    print('wchar delta, native (wchar=2, MSVC) -> wasm default (wchar=4, Itanium):')
    for t in delta['types']:
        print(f'  {t["type"]}: {t["sizeSmall"]} -> {t["sizeBig"]} ({t["sizeDelta"]:+d} bytes)')
    for r in delta['records']:
        print(f'  record {r["record"]}: {r["sizeSmall"]} -> {r["sizeBig"]} ({r["delta"]:+d} bytes)')
    print()
    print('wchar delta, native -> wasm with -fshort-wchar (wchar=2, Itanium):')
    for t in delta_short['types']:
        print(f'  {t["type"]}: {t["sizeSmall"]} -> {t["sizeBig"]} ({t["sizeDelta"]:+d} bytes)')
    for r in delta_short['records']:
        print(f'  record {r["record"]}: {r["sizeSmall"]} -> {r["sizeBig"]} ({r["delta"]:+d} bytes)')
    print()

    return summarise(CHECKS, args)


def summarise(checks: list[tuple[str, bool, str]], args) -> int:
    passed = sum(1 for _, ok, _ in checks if ok)
    print(f'{passed}/{len(checks)} checks passed')
    if args.skip_build:
        print('(build skipped: results are from existing binaries)')
    return 0 if passed == len(checks) else 1


if __name__ == '__main__':
    sys.exit(main())
