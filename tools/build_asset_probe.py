"""Build and verify the standalone native/WASM PAK index probe."""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'probes' / 'asset-reader'


def run(args: list[str], env: dict | None = None) -> None:
    subprocess.run(args, cwd=ROOT, env=env, check=True)


def cmake_path() -> Path:
    query = Path(os.environ.get('ProgramFiles(x86)', 'C:/Program Files (x86)')) / 'Microsoft Visual Studio/Installer/vswhere.exe'
    location = subprocess.check_output([str(query), '-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], text=True).strip()
    if not location:
        raise RuntimeError('Visual Studio C++ build tools not found')
    return Path(location) / 'Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe'


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--native-only', action='store_true')
    parser.add_argument('--wasm-only', action='store_true')
    args = parser.parse_args()
    if args.native_only and args.wasm_only:
        parser.error('Choose at most one build mode')
    if not args.wasm_only:
        cmake = cmake_path()
        build = ROOT / '_work/build/asset-reader-native'
        run([str(cmake), '-S', str(SOURCE), '-B', str(build), '-G', 'Visual Studio 17 2022', '-A', 'x64'])
        run([str(cmake), '--build', str(build), '--config', 'Release'])
        ctest = cmake.with_name('ctest.exe')
        run([str(ctest), '--test-dir', str(build), '-C', 'Release', '--output-on-failure'])
    if not args.native_only:
        sdk = ROOT / '_work/toolchains/emsdk'
        output = SOURCE / 'web/generated'
        output.mkdir(parents=True, exist_ok=True)
        compiler = sdk / 'upstream/emscripten/em++.py'
        if not compiler.exists():
            raise RuntimeError('Install and activate the pinned emsdk first')
        run([sys.executable, str(compiler), str(SOURCE / 'src/pak_reader.cpp'), str(SOURCE / 'src/model_inspector.cpp'), str(SOURCE / 'src/mesh_reader.cpp'), str(SOURCE / 'src/texture_reader.cpp'), str(SOURCE / 'src/scene_reader.cpp'), str(SOURCE / 'src/xt_reader.cpp'), '-std=c++17', '-O2', '-fexceptions', '--no-entry', '-sMODULARIZE=1', '-sEXPORT_ES6=1', '-sENVIRONMENT=web,node', '-sALLOW_MEMORY_GROWTH=1', '-sMAXIMUM_MEMORY=268435456', '-sINITIAL_MEMORY=16777216', '-sEXPORTED_FUNCTIONS=["_pak_inspect","_pak_free","_model_inspect","_model_free","_mesh_inspect","_mesh_free","_texture_inspect","_texture_raw_inspect","_texture_free","_scene_inspect","_scene_resource_textures_inspect","_level_index_inspect","_level_mesh_inspect","_level_instances_inspect","_level_instances_all_inspect","_scene_free","_xt_inspect","_xt_free","_malloc","_free"]', '-sEXPORTED_RUNTIME_METHODS=["UTF8ToString","HEAPU8"]', '-o', str(output / 'pak_reader.mjs')])
        version = subprocess.check_output([sys.executable, str(sdk / 'upstream/emscripten/emcc.py'), '--version'], text=True).splitlines()[0]
        (output / 'build.json').write_text(json.dumps({'emscripten': version, 'source': 'probes/asset-reader/src/pak_reader.cpp', 'scope': 'PAK index, model and streamed level geometry subsets, PC textures, XT schema metadata'}, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()






