#!/usr/bin/env python3
"""Build, run and cross-check the T-005d collision oracle.

    python probes/collision-oracle/tests/run_collision_oracle.py [--skip-build]

Steps: native configure/build, CTest, native run (twice), wasm32 build, node
run, independent Python reference, native/wasm/Python comparison, malformed and
truncated input rejection. Everything lands in _work/collision-oracle/.
"""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PROBE = os.path.join(ROOT, 'probes', 'collision-oracle')
WORK = os.path.join(ROOT, '_work', 'collision-oracle')
BUILD = os.path.join(WORK, 'build')
NATIVE_BUILD = os.path.join(ROOT, '_work', 'build', 'collision-oracle-native')
LEVEL = os.path.join(ROOT, 'game-data', 'Blur', 'levels', 'usa_la_river', 'Level.levelphysics')

CMAKE_CANDIDATES = [
    r'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe',
    'cmake',
]
EMXX = os.path.join(ROOT, '_work', 'toolchains', 'emsdk', 'upstream', 'emscripten', 'em++.py')


def find_python():
    return sys.executable


def find_cmake():
    for candidate in CMAKE_CANDIDATES:
        if os.path.isabs(candidate):
            if os.path.exists(candidate):
                return candidate
        elif shutil.which(candidate):
            return candidate
    return None


def run(cmd, log_name, cwd=ROOT, env=None, check=True):
    os.makedirs(os.path.join(WORK, 'logs'), exist_ok=True)
    log_path = os.path.join(WORK, 'logs', log_name)
    started = time.time()
    proc = subprocess.run(cmd, cwd=cwd, env=env, capture_output=True)
    elapsed = time.time() - started
    with open(log_path, 'wb') as fh:
        fh.write(proc.stdout)
        fh.write(b'\n--- stderr ---\n')
        fh.write(proc.stderr)
    if check and proc.returncode != 0:
        sys.stderr.write('command failed (%d): %s\n' % (proc.returncode, ' '.join(cmd)))
        sys.stderr.write(proc.stdout.decode('utf-8', 'replace')[-4000:])
        sys.stderr.write(proc.stderr.decode('utf-8', 'replace')[-4000:])
        raise SystemExit(1)
    return proc.returncode, proc.stdout.decode('utf-8', 'replace'), elapsed


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as fh:
        for block in iter(lambda: fh.read(1 << 20), b''):
            h.update(block)
    return h.hexdigest()


def load(path):
    with open(path, encoding='utf-8') as fh:
        return json.load(fh)


def compare_queries(native, other, label, failures):
    keys = ('rays', 'spheres', 'cacheQueries')
    if other.get('formatVersion') != native.get('formatVersion'):
        failures.append('%s: formatVersion %r != %r'
                        % (label, native.get('formatVersion'), other.get('formatVersion')))
    for key in keys:
        a = native.get(key, [])
        b = other.get(key, [])
        if len(a) != len(b):
            failures.append('%s: %s count %d != %d' % (label, key, len(a), len(b)))
            continue
        for x, y in zip(a, b):
            if x.get('record') != y.get('record'):
                failures.append('%s: %s %s record differs' % (label, key, x.get('label')))
    if native.get('hashes') != other.get('hashes'):
        failures.append('%s: queryHash differs %s != %s'
                        % (label, native.get('hashes', {}).get('queryHash'),
                           other.get('hashes', {}).get('queryHash')))
    for key in ('numVertices', 'numNormals', 'numTriangles', 'numLeaves', 'numNodes',
                'numHeaders', 'numActiveEdges', 'triangleCapacityBytes',
                'triangleBufferBytes', 'vertexStreamHash', 'vertexQuantisedHash',
                'normalHash', 'nodeHash', 'triangleHash', 'identityInstance'):
        a = [m.get(key) for m in native.get('meshes', [])]
        b = [m.get(key) for m in other.get('meshes', [])]
        if a != b:
            failures.append('%s: mesh field %s differs' % (label, key))


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument('--skip-build', action='store_true')
    args = ap.parse_args(argv)

    python = find_python()
    cmake = find_cmake()
    failures = []
    checks = []

    def check(name, ok, detail=''):
        checks.append(dict(name=name, ok=bool(ok), detail=detail))
        if not ok:
            failures.append('%s %s' % (name, detail))
        print('%-34s %s %s' % (name, 'PASS' if ok else 'FAIL', detail))

    os.makedirs(WORK, exist_ok=True)
    os.makedirs(BUILD, exist_ok=True)

    if not os.path.exists(LEVEL):
        print('missing level file: %s' % LEVEL)
        return 1

    native_exe = os.path.join(NATIVE_BUILD, 'Release', 'collision_oracle_cli.exe')
    native_tests = os.path.join(NATIVE_BUILD, 'Release', 'collision_oracle_tests.exe')
    wasm_module = os.path.join(BUILD, 'collision_oracle.mjs')

    if not args.skip_build:
        if cmake is None:
            print('cmake not found')
            return 1
        rc, _, _ = run([cmake, '-S', PROBE, '-B', NATIVE_BUILD, '-G', 'Visual Studio 17 2022', '-A', 'x64'],
                       'configure-native.log', check=False)
        check('configure-native', rc == 0)
        rc, _, _ = run([cmake, '--build', NATIVE_BUILD, '--config', 'Release'], 'build-native.log', check=False)
        check('build-native', rc == 0)
        if rc != 0:
            return 1

        rc, out, _ = run([cmake, '--build', NATIVE_BUILD, '--config', 'Release'], 'build-native-repeat.log',
                         check=False)
        warnings = [line for line in out.splitlines() if ' warning ' in line]
        check('native-warning-free', not warnings, '%d warning line(s)' % len(warnings))

        if not os.path.exists(EMXX):
            check('build-wasm', False, 'emsdk not found at %s' % EMXX)
        else:
            wasm_cmd = [
                python, EMXX,
                os.path.join(PROBE, 'src', 'level_physics.cpp'),
                os.path.join(PROBE, 'src', 'queries.cpp'),
                os.path.join(PROBE, 'src', 'query_table.cpp'),
                os.path.join(PROBE, 'src', 'oracle_run.cpp'),
                os.path.join(PROBE, 'src', 'wasm_entry.cpp'),
                '-std=c++17', '-O2', '-fno-fast-math', '-ffp-contract=off',
                '-sMODULARIZE=1', '-sEXPORT_ES6=1', '-sENVIRONMENT=node,web',
                '-sALLOW_MEMORY_GROWTH=1', '-sINITIAL_MEMORY=67108864', '--no-entry',
                '-sEXPORTED_FUNCTIONS=_oracle_run,_oracle_free,_oracle_selftest,_oracle_flags,_malloc,_free',
                '-sEXPORTED_RUNTIME_METHODS=UTF8ToString,stringToUTF8,lengthBytesUTF8,HEAPU8',
                '-o', wasm_module,
            ]
            rc, _, _ = run(wasm_cmd, 'build-wasm.log', check=False)
            check('build-wasm', rc == 0)

    for path, name in ((native_exe, 'native-exe'), (native_tests, 'native-tests'),
                       (wasm_module, 'wasm-module')):
        check(name + '-present', os.path.exists(path), path)

    if not os.path.exists(native_exe):
        return 1

    rc, out, _ = run([native_exe, '--selftest'], 'native-selftest.log', check=False)
    check('native-selftest', rc == 0 and 'PASS' in out)

    rc, _, _ = run([native_tests, LEVEL], 'native-tests.log', check=False)
    check('native-unit-tests', rc == 0)

    native_json = os.path.join(WORK, 'native.json')
    native_json2 = os.path.join(WORK, 'native2.json')
    rc, _, elapsed = run([native_exe, '--in', LEVEL, '--out', native_json], 'run-native.log', check=False)
    check('run-native', rc == 0, '%.2fs' % elapsed)
    rc, _, _ = run([native_exe, '--in', LEVEL, '--out', native_json2], 'run-native2.log', check=False)
    check('run-native-repeat', rc == 0)
    if rc == 0 and os.path.exists(native_json) and os.path.exists(native_json2):
        check('determinism-native', sha256_file(native_json) == sha256_file(native_json2))

    native = load(native_json) if os.path.exists(native_json) else {}
    check('native-status-ok', native.get('status') == 'ok')
    check('native-format-version-v2', native.get('formatVersion') == 2)
    if native.get('status') != 'ok':
        print(json.dumps(native, indent=1)[:2000])
        return 1

    if os.path.exists(wasm_module):
        wasm_json = os.path.join(WORK, 'wasm.json')
        wasm_json2 = os.path.join(WORK, 'wasm2.json')
        rc, _, elapsed = run(['node', os.path.join(PROBE, 'tests', 'verify_oracle_wasm.mjs'),
                              wasm_module, LEVEL, wasm_json], 'run-wasm.log', check=False)
        check('run-wasm', rc == 0, '%.2fs' % elapsed)
        rc2, _, _ = run(['node', os.path.join(PROBE, 'tests', 'verify_oracle_wasm.mjs'),
                         wasm_module, LEVEL, wasm_json2], 'run-wasm2.log', check=False)
        check('run-wasm-repeat', rc2 == 0)
        if rc == 0 and rc2 == 0:
            check('determinism-wasm', sha256_file(wasm_json) == sha256_file(wasm_json2))
        if rc == 0:
            wasm = load(wasm_json)
            check('wasm-status-ok', wasm.get('status') == 'ok')
            compare_queries(native, wasm, 'native-vs-wasm', failures)
            check('native-vs-wasm', not any(f.startswith('native-vs-wasm') for f in failures))
            # Everything except the build block must be identical. `input.label`
            # is the one documented exception: it names the host buffer.
            a = dict(native)
            b = dict(wasm)
            a.pop('build', None)
            b.pop('build', None)
            a_input = dict(a.pop('input', {}))
            b_input = dict(b.pop('input', {}))
            a_input.pop('label', None)
            b_input.pop('label', None)
            check('native-vs-wasm-document',
                  json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)
                  and a_input == b_input,
                  'input.label excluded')

    reference_json = os.path.join(WORK, 'reference.json')
    rc, _, elapsed = run([python, os.path.join(PROBE, 'tests', 'reference_oracle.py'),
                          '--in', LEVEL, '--out', reference_json], 'run-reference.log', check=False)
    check('run-reference', rc == 0, '%.2fs' % elapsed)
    if rc == 0:
        reference = load(reference_json)
        check('reference-status-ok', reference.get('status') == 'ok')
        compare_queries(native, reference, 'native-vs-python', failures)
        check('native-vs-python', not any(f.startswith('native-vs-python') for f in failures))

    # Malformed / truncated input must be rejected with a code and an offset.
    malformed_dir = os.path.join(WORK, 'malformed')
    os.makedirs(malformed_dir, exist_ok=True)
    with open(LEVEL, 'rb') as fh:
        raw = fh.read()

    def write_case(name, payload):
        path = os.path.join(malformed_dir, name)
        with open(path, 'wb') as fh:
            fh.write(payload)
        return path

    def inner_truncate(cut):
        """Truncate the payload and patch root/Main sizes so block framing stays
        self-consistent and the bounded reader is the thing that rejects it."""
        payload = bytearray(raw[:cut])
        main_size = cut - 60 + 16
        payload[52:56] = struct_pack_u32(main_size)
        payload[12:16] = struct_pack_u32(cut - 4)
        return bytes(payload)

    cases = [
        ('marker-bad.bin', b'  X' + raw[4:]),
        ('root-id-bad.bin', raw[:4] + b'Physix\x00\x00' + raw[12:]),
        ('root-size-bad.bin', raw[:12] + struct_pack_u32(1945405 + 4) + raw[16:]),
        ('truncate-1024.bin', raw[:1024]),
        ('truncate-641965.bin', raw[:641965]),
        ('truncate-1896920.bin', raw[:1896920]),
        ('truncate-half.bin', raw[:len(raw) // 2]),
        ('truncate-empty.bin', b''),
        ('inner-truncate-1024.bin', inner_truncate(1024)),
        ('inner-truncate-139.bin', inner_truncate(139)),
        ('inner-truncate-641965.bin', inner_truncate(641965)),
        ('inner-truncate-900000.bin', inner_truncate(900000)),
        ('inner-truncate-1896890.bin', inner_truncate(1896890)),
    ]

    rejected = 0
    codes = []
    for name, payload in cases:
        path = write_case(name, payload)
        native_out = os.path.join(malformed_dir, name + '.native.json')
        rc, out, _ = run([native_exe, '--in', path, '--out', native_out],
                         'malformed.log', check=False)
        native_result = load(native_out) if os.path.exists(native_out) else None
        if os.path.exists(native_out):
            os.remove(native_out)

        wasm_result = None
        if os.path.exists(wasm_module):
            wasm_out = os.path.join(malformed_dir, name + '.wasm.json')
            run(['node', os.path.join(PROBE, 'tests', 'verify_oracle_wasm.mjs'),
                 wasm_module, path, wasm_out], 'malformed.log', check=False)
            wasm_result = load(wasm_out) if os.path.exists(wasm_out) else None
            if os.path.exists(wasm_out):
                os.remove(wasm_out)

        ref_out = os.path.join(malformed_dir, name + '.reference.json')
        run([python, os.path.join(PROBE, 'tests', 'reference_oracle.py'),
             '--in', path, '--out', ref_out], 'malformed.log', check=False)
        reference_result = load(ref_out) if os.path.exists(ref_out) else {}
        if os.path.exists(ref_out):
            os.remove(ref_out)

        native_error = (native_result or {}).get('error', {})
        # Native and wasm share one code path, so their diagnostics must match
        # exactly. The Python reference has its own guard order and only has to
        # reject; its code/offset are recorded, not required to be identical.
        same_native_wasm = (
            (native_result or {}).get('status') == 'error'
            and (wasm_result or {}).get('status') == 'error'
            and native_error.get('code') == (wasm_result or {}).get('error', {}).get('code')
            and native_error.get('offset') == (wasm_result or {}).get('error', {}).get('offset'))
        python_rejected = (reference_result or {}).get('status') == 'error'
        if rc == 5 and native_error.get('code') and 'offset' in native_error \
                and same_native_wasm and python_rejected:
            rejected += 1
        else:
            failures.append('malformed %s: native=%s wasm=%s python=%s'
                            % (name, native_error, (wasm_result or {}).get('error'),
                               reference_result.get('error')))
        codes.append(dict(case=name, code=native_error.get('code'),
                          offset=native_error.get('offset'),
                          wasmCode=(wasm_result or {}).get('error', {}).get('code'),
                          pythonCode=(reference_result or {}).get('error', {}).get('code'),
                          pythonOffset=(reference_result or {}).get('error', {}).get('offset'),
                          exitCode=rc))
    check('malformed-rejection', rejected == len(cases), '%d/%d' % (rejected, len(cases)))

    summary = dict(
        status='pass' if not failures else 'fail',
        checks=checks,
        failures=failures,
        environment=dict(
            python=sys.version.split()[0],
            cmake=cmake,
            emscripten=EMXX if os.path.exists(EMXX) else None,
            node=shutil.which('node'),
            node_version=run(['node', '--version'], 'node-version.log', check=False)[1].strip()),
        input=dict(path=os.path.relpath(LEVEL, ROOT).replace('\\', '/'),
                   size=len(raw), sha256=sha256_file(LEVEL)),
        results=dict(
            formatVersion=native.get('formatVersion'),
            queryHash=native.get('hashes', {}).get('queryHash'),
            canonicalRecordBytes=native.get('hashes', {}).get('canonicalRecordBytes'),
            meshHashes=[m.get('triangleHash') for m in native.get('meshes', [])],
            counts=native.get('counts'),
        ),
        malformed=codes,
        artifacts=dict(
            native=os.path.relpath(native_json, ROOT).replace('\\', '/'),
            wasm=os.path.relpath(os.path.join(WORK, 'wasm.json'), ROOT).replace('\\', '/'),
            reference=os.path.relpath(reference_json, ROOT).replace('\\', '/'),
        ),
    )
    summary_path = os.path.join(WORK, 'summary.json')
    with open(summary_path, 'w', encoding='utf-8') as fh:
        json.dump(summary, fh, indent=2)
        fh.write('\n')

    print()
    print('%d/%d checks passed' % (sum(1 for c in checks if c['ok']), len(checks)))
    print('queryHash %s' % summary['results']['queryHash'])
    print('summary   %s' % summary_path)
    if failures:
        for f in failures:
            print('FAILURE: %s' % f)
        return 1
    return 0


def struct_pack_u32(value):
    return value.to_bytes(4, 'little')


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
