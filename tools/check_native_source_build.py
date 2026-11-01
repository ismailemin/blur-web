"""Audit native Blur build inputs without generating files in the source checkout.

--configure runs x64 and Win32 CMake configure only. Amax is never built here:
its custom commands write generated headers and shaders into the source tree.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def capture(command: list[str], cwd: Path, log: Path) -> dict:
    result = subprocess.run(command, cwd=cwd, text=True, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, encoding='utf-8', errors='replace', check=False)
    log.write_text(result.stdout, encoding='utf-8')
    errors = [line.strip() for line in result.stdout.splitlines()
              if 'error' in line.lower() or 'missing' in line.lower() or 'not found' in line.lower()]
    return {'command': command, 'exitCode': result.returncode, 'log': str(log), 'diagnostics': errors[:20]}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=ROOT / 'upstream/BlurRebuilt')
    parser.add_argument('--out-dir', type=Path, default=ROOT / '_work/build/engine-reference')
    parser.add_argument('--atl-root', type=Path, help='Locally extracted Microsoft ATL atlmfc directory')
    parser.add_argument('--configure', action='store_true')
    args = parser.parse_args()
    source = args.source.resolve(strict=True)
    output = args.out_dir.resolve()
    if output.is_relative_to(source):
        parser.error('Output must be outside the source checkout')
    output.mkdir(parents=True, exist_ok=True)
    status_before = subprocess.check_output(['git', '-C', str(source), 'status', '--porcelain'], text=True)
    commit = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
    query = Path(os.environ.get('ProgramFiles(x86)', 'C:/Program Files (x86)')) / 'Microsoft Visual Studio/Installer/vswhere.exe'
    vs = json.loads(subprocess.check_output([str(query), '-latest', '-products', '*', '-requires',
                        'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-format', 'json', '-utf8'], text=True, encoding='utf-8'))[0]
    cmake = Path(vs['installationPath']) / 'Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe'
    msvc_version = (Path(vs['installationPath']) / 'VC/Auxiliary/Build/Microsoft.VCToolsVersion.default.txt').read_text(encoding='utf-8-sig').strip()
    msvc_family = '.'.join(msvc_version.split('.')[:2])
    atl_root = (args.atl_root.resolve() if args.atl_root else ROOT / f'_work/vendor/atl-v143-{msvc_family}/Contents/VC/Tools/MSVC/{msvc_version}/atlmfc')
    atl_override = 'BLUR_LOCAL_ATL_ROOT' in (source / 'cmake/overrides.cmake').read_text(encoding='utf-8')
    targets_text = (source / 'cmake/targets.cmake').read_text(encoding='utf-8')
    generated = sorted(set(re.findall(r'\$\{BLUR_PROJECT\}/(_work/[^\s)]+)', targets_text)))
    cp_inputs = sorted(p for base in (source / 'code/mercury/library', source / 'code/amax/game')
                       for p in base.rglob('*') if p.is_file() and p.suffix.lower() in ('.cp', '.cv', '.sp'))
    missing_headers = [str(p.relative_to(source).with_suffix('.h')) for p in cp_inputs if not p.with_suffix('.h').exists()]
    vendor = ROOT / '_work/vendor'
    openssl = ROOT / '_work/vendor_x64/openssl-x64'
    expected = {
        'd3dx9Headers': vendor / 'd3dx/build/native/include/d3dx9.h',
        'openalHeaders': vendor / 'openal-soft-1.24.3-bin/include/AL/al.h',
        'openalX64Import': vendor / 'openal-soft-1.24.3-bin/libs/Win64/OpenAL32.lib',
        'jpegSources': vendor / 'jpeg-6b/jpeglib.h',
        'opensslX64Crypto': openssl / 'lib/libeay32.lib',
        'opensslX64Tls': openssl / 'lib/ssleay32.lib',
        'demonwareBundledX86': source / 'code/vendor/demonware/2.0/lib/win32-vs8/release-mt/bdCore.lib',
        'localAtlHeader': atl_root / 'include/atlbase.h',
        'localAtlX64Library': atl_root / 'lib/x64/atls.lib',
    }
    sdk_bin = Path(os.environ.get('ProgramFiles(x86)', 'C:/Program Files (x86)')) / 'Windows Kits/10/bin'
    report = {'source': str(source), 'commit': commit, 'sourceStatusBefore': status_before,
              'sourceWorkDirectoryBefore': (source / '_work').exists(),
              'visualStudio': {'path': vs['installationPath'], 'version': vs['installationVersion'],
                               'cmake': str(cmake), 'msvcToolsVersion': msvc_version},
              'localAtl': {'root': str(atl_root), 'isolatedOverrideAvailable': atl_override},
              'fxcExecutables': [str(p) for p in sorted(sdk_bin.glob('*/x86/fxc.exe'))],
              'perlOnPath': shutil.which('perl'),
              'cmakeTargetCount': len(re.findall(r'^add_(?:library|executable)\(', targets_text, re.M)),
              'generatedInputs': [{'path': name, 'exists': (source / name).exists()} for name in generated],
              'cpInputCount': len(cp_inputs), 'missingCpHeaderCount': len(missing_headers),
              'missingCpHeaders': missing_headers,
              'vendorInputs': {key: {'path': str(path), 'exists': path.exists()} for key, path in expected.items()},
              'buildAttempted': False,
              'buildSkippedReason': 'Amax custom commands write source-side generated headers and source/_work; use isolated writable checkout.',
              'commands': []}
    # Jam evaluation is explicitly read-only and its output is redirected here.
    report['commands'].append(capture([sys.executable, str(source / 'tools/jam2cmake/jamextract.py'),
        '--top', str(source), '--root', 'code/amax/game/jamfile.jam', '--target', 'WIN32',
        '--platform', 'PC', '--build', 'Speed', '--out', str(output / 'targets_pc_speed.json')], ROOT, output / 'jam-evaluation.log'))
    jam_file = output / 'targets_pc_speed.json'
    if jam_file.exists():
        jam = json.loads(jam_file.read_text(encoding='utf-8'))
        supported = [t for t in jam['targets'] if t['supported']]
        report['jam'] = {'targetCount': len(jam['targets']), 'supportedTargetCount': len(supported),
                         'supportedSourceCount': sum(len(t['sources']) for t in supported),
                         'missingSourceCount': len(jam['missing_sources']), 'unknownRules': jam['unknown_rules']}
    if args.configure:
        for arch in ('x64', 'Win32'):
            command = [str(cmake), '-S', str(source), '-B', str(output / arch),
                       '-G', 'Visual Studio 17 2022', '-A', arch,
                       f'-DBLUR_VENDOR={vendor}', f'-DBLUR_JPEG_DIR={vendor / "jpeg-6b"}',
                       f'-DBLUR_OPENSSL_X64={openssl}', f'-DPython3_EXECUTABLE={sys.executable}']
            if atl_override and (atl_root / 'include/atlbase.h').exists():
                command.append(f'-DBLUR_LOCAL_ATL_ROOT={atl_root}')
            report['commands'].append(capture(command, ROOT, output / f'configure-{arch}.log'))
    report['sourceStatusAfter'] = subprocess.check_output(['git', '-C', str(source), 'status', '--porcelain'], text=True)
    report['trackedAndUntrackedStatusUnchanged'] = report['sourceStatusAfter'] == status_before
    report['sourceWorkDirectoryAfter'] = (source / '_work').exists()
    report['previouslyMissingCpHeadersCreated'] = [p for p in missing_headers if (source / p).exists()]
    (output / 'readiness.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({k: report[k] for k in ('commit', 'cmakeTargetCount', 'cpInputCount', 'missingCpHeaderCount',
                                            'jam', 'trackedAndUntrackedStatusUnchanged', 'commands')}, indent=2))


if __name__ == '__main__':
    main()
