"""Build the deterministic P73a level-instance UV/material artifact.

Reads the committed native reader output for River block27/node253, joins the
static g_tAlbedo resource identity to the committed P34/P47 texture registry, and
writes the UV0 stream plus the 18 BC1-bindable / 4 BC3-blocked draw split.

The independent Python reference (tests/verify_instance_textures_reference.py)
is rebuilt in-process and every draw hash, span and texture identity is checked
before anything is written. No renderer, game data or upstream file is touched.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import struct
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
TESTS = ROOT / 'probes/asset-reader/tests'
sys.path.insert(0, str(TESTS))
from verify_instance_textures_reference import build_reference  # noqa: E402

LEVEL = ROOT / 'game-data/Blur/levels/usa_la_river/level.levelrender'
STREAM = ROOT / 'game-data/Blur/levels/usa_la_river/level.levelstream'
GEOMETRY = ROOT / '_work/level-instances/instance-geometry.chunk'
NODE = ROOT / '_work/level-instances/instance-node.chunk'
REGISTRY = ROOT / '_work/logs/engine-stream-spike/engine-textures.json'
NATIVE = ROOT / '_work/build/asset-reader-native/Release/level_inspect.exe'
DEFAULT_OUT = ROOT / '_work/asset-reader'
BC1 = 827611204
BC3 = 894720068
FORMAT_NAMES = {BC1: 'DXT1/BC1', BC3: 'DXT5/BC3'}
KNOWN_NAMES = {1073: 'car01_lic_diff', 1112: 'car02_lic_diff', 1118: 'car03_lic_diff',
               1074: 'bigtruck02_diff', 1205: 'cab01alphas_diff'}


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_path(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1 << 20), b''):
            digest.update(block)
    return digest.hexdigest()


def fnv1a64(data: bytes) -> str:
    value = 0xCBF29CE484222325
    for byte in data:
        value ^= byte
        value = (value * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return f'{value:016x}'


def run_native():
    completed = subprocess.run(
        [str(NATIVE), '--instances-all', str(LEVEL), str(GEOMETRY), str(NODE), '27', '253'],
        cwd=ROOT, check=True, capture_output=True)
    return json.loads(completed.stdout.decode('utf-8'))


def build(out_dir: Path):
    for path in (LEVEL, STREAM, GEOMETRY, NODE, REGISTRY, NATIVE):
        if not path.exists():
            raise SystemExit(f'missing input {path}')

    native = run_native()
    if json.dumps(native, sort_keys=True, allow_nan=False) != json.dumps(run_native(), sort_keys=True, allow_nan=False):
        raise SystemExit('two native reader runs are not byte-identical')
    reference = build_reference()
    if native.get('status') != 'ok':
        raise SystemExit('native reader failed: ' + native.get('error', 'unknown'))
    if len(native['draws']) != 22 or len(reference['draws']) != 22:
        raise SystemExit('draw count differs from the 22-draw reference')
    if native['metadata']['uv0Values'] != 26324 or native['metadata']['uv0Bytes'] != 105296:
        raise SystemExit('UV0 stream size differs from the expected 26,324 values / 105,296 bytes')
    if reference['uvValues'] != 26324 or reference['uvBytes'] != 105296:
        raise SystemExit('Python UV0 stream size differs from the expected size')

    uv_bytes = struct.pack('<%df' % len(native['uv0']), *native['uv0'])
    if len(uv_bytes) != 105296:
        raise SystemExit('native UV0 byte length differs')
    uv_sha = sha256_bytes(uv_bytes)
    if uv_sha != reference['uvSha256']:
        raise SystemExit('native/Python UV0 stream SHA-256 differs')
    if native['metadata']['uv0Aggregate'] != reference['uvAggregate']:
        raise SystemExit('native/Python UV0 aggregate differs')

    positions = struct.pack('<%df' % len(native['positions']), *native['positions'])
    indices = struct.pack('<%dI' % len(native['indices']), *native['indices'])

    registry = json.loads(REGISTRY.read_text(encoding='utf-8'))
    texture_by_source = {(item['block'], item['index']): item for item in registry['textures']}

    draws = []
    texture_sources = {}
    for index, (native_draw, reference_draw) in enumerate(zip(native['draws'], reference['draws'])):
        for key in ('instanceIndex', 'basePrimitiveIndex', 'firstIndex', 'indexCount', 'uvHash',
                    'uvType', 'uvOffset', 'uvStride', 'materialRow', 'material',
                    'resourceBlock', 'resourceIndex'):
            if native_draw[key] != reference_draw[key]:
                raise SystemExit(f'draw {index}: native/Python {key} differs')
        key = (native_draw['resourceBlock'], native_draw['resourceIndex'])
        texture = texture_by_source.get(key)
        if texture is None:
            raise SystemExit(f'draw {index}: texture source {key} is absent from the P34 registry')
        if texture['name'] != KNOWN_NAMES.get(key[0]):
            raise SystemExit(f'draw {index}: registry name {texture["name"]} differs')
        if texture['format'] not in (BC1, BC3):
            raise SystemExit(f'draw {index}: unsupported albedo format {texture["format"]}')
        triangle_count = native_draw['indexCount'] // 3
        if native_draw['indexCount'] != reference_draw['indexCount']:
            raise SystemExit(f'draw {index}: triangle span differs')
        bindable = texture['format'] == BC1 and native_draw['uv0Available']
        blocked_reason = None
        if not native_draw['uv0Available']:
            blocked_reason = 'uv0-unavailable'
        elif not bindable:
            blocked_reason = 'bc3-alpha-rule-missing' if texture['format'] == BC3 else 'unsupported-albedo-format'
        record = {
            'instanceIndex': native_draw['instanceIndex'],
            'basePrimitiveIndex': native_draw['basePrimitiveIndex'],
            'firstIndex': native_draw['firstIndex'],
            'indexCount': native_draw['indexCount'],
            'triangleCount': triangle_count,
            'uv0Available': native_draw['uv0Available'],
            'uvHash': native_draw['uvHash'],
            'uvType': native_draw['uvType'],
            'uvOffset': native_draw['uvOffset'],
            'uvStride': native_draw['uvStride'],
            'material': native_draw['material'],
            'materialRow': native_draw['materialRow'],
            'albedoParameter': native_draw['albedoParameter'],
            'albedoTexture': texture['name'],
            'albedoTextureId': native_draw['albedoTextureId'],
            'resourceBlock': key[0],
            'resourceIndex': key[1],
            'texture': {
                'name': texture['name'],
                'format': texture['format'],
                'formatName': FORMAT_NAMES[texture['format']],
                'width': texture['width'],
                'height': texture['height'],
                'levels': texture['levels'],
                'rgbaBytes': texture['rgbaBytes'],
                'rgbaFnv1a64': texture['rgbaHash'],
            },
            'bindingStatus': 'bindable-bc1' if bindable else 'blocked',
            'bindable': bindable,
            'blockedReason': blocked_reason,
        }
        draws.append(record)
        source = texture_sources.setdefault(key, {
            'block': key[0], 'index': key[1], 'name': texture['name'],
            'format': texture['format'], 'formatName': FORMAT_NAMES[texture['format']],
            'width': texture['width'], 'height': texture['height'], 'levels': texture['levels'],
            'rgbaBytes': texture['rgbaBytes'], 'rgbaFnv1a64': texture['rgbaHash'],
            'draws': [], 'triangles': 0, 'bindableDraws': 0,
        })
        source['draws'].append(native_draw['instanceIndex'])
        source['triangles'] += triangle_count
        source['bindableDraws'] += 1 if bindable else 0

    bindable = [draw for draw in draws if draw['bindable']]
    blocked = [draw for draw in draws if not draw['bindable']]
    bc1_draws, bc1_triangles = len(bindable), sum(draw['triangleCount'] for draw in bindable)
    bc3_draws, bc3_triangles = len(blocked), sum(draw['triangleCount'] for draw in blocked)
    if (bc1_draws, bc1_triangles) != (18, 10212):
        raise SystemExit(f'BC1 split differs: {bc1_draws}/{bc1_triangles}')
    if (bc3_draws, bc3_triangles) != (4, 96):
        raise SystemExit(f'BC3 split differs: {bc3_draws}/{bc3_triangles}')
    if len(texture_sources) != 5:
        raise SystemExit(f'level albedo source count differs: {len(texture_sources)}')
    if any(draw['blockedReason'] != 'bc3-alpha-rule-missing' for draw in blocked):
        raise SystemExit('a blocked draw is not labelled bc3-alpha-rule-missing')

    out_dir.mkdir(parents=True, exist_ok=True)
    uv_path = out_dir / 'level-instance-uv.bin'
    uv_path.write_bytes(uv_bytes)
    reader_path = out_dir / 'level-instances-all.json'
    reader_text = json.dumps(native, sort_keys=True, ensure_ascii=False, allow_nan=False)
    reader_path.write_text(reader_text + '\n', encoding='utf-8')

    inputs = {
        'levelRender': {'path': str(LEVEL.relative_to(ROOT)), 'bytes': LEVEL.stat().st_size, 'sha256': sha256_path(LEVEL)},
        'levelStream': {'path': str(STREAM.relative_to(ROOT)), 'bytes': STREAM.stat().st_size, 'sha256': sha256_path(STREAM)},
        'geometryChunk': {'path': str(GEOMETRY.relative_to(ROOT)), 'bytes': GEOMETRY.stat().st_size, 'sha256': sha256_path(GEOMETRY)},
        'nodeChunk': {'path': str(NODE.relative_to(ROOT)), 'bytes': NODE.stat().st_size, 'sha256': sha256_path(NODE)},
        'textureRegistry': {'path': str(REGISTRY.relative_to(ROOT)), 'sha256': sha256_path(REGISTRY)},
    }

    artifact = {
        'kind': 'asset-reader.level-instance-textures',
        'version': 1,
        'level': 'usa_la_river',
        'nodeBlock': 253,
        'geometryBlock': 27,
        'scope': 'River node253 block27 level instances: source UV0 and static g_tAlbedo resource identity only; no renderer, alpha, blend, shader, sampler or mip application',
        'mesh': {
            'readerOutput': str(reader_path.relative_to(ROOT)),
            'readerOutputSha256': sha256_bytes(reader_path.read_bytes()),
            'vertexCount': len(native['positions']) // 3,
            'triangleCount': len(native['indices']) // 3,
            'positionsSha256': sha256_bytes(positions),
            'indicesSha256': sha256_bytes(indices),
        },
        'uv0': {
            'file': str(uv_path.relative_to(ROOT)),
            'encoding': 'float32le',
            'components': 2,
            'values': len(native['uv0']),
            'bytes': len(uv_bytes),
            'sha256': uv_sha,
            'aggregate': native['metadata']['uv0Aggregate'],
            'declaration': {'usage': 5, 'usageIndex': 0, 'type': 8, 'offset': 16, 'stride': 20},
            'parallelTo': 'level-instances-all.json positions (2 floats per vertex)',
        },
        'draws': draws,
        'bindable': {
            'status': 'bindable-bc1',
            'draws': bc1_draws,
            'triangles': bc1_triangles,
            'instanceIndices': [draw['instanceIndex'] for draw in bindable],
            'rule': 'static g_tAlbedo resolves to a DXT1/BC1 texture and UV0 is exported for the draw',
        },
        'blocked': {
            'status': 'blocked',
            'draws': bc3_draws,
            'triangles': bc3_triangles,
            'instanceIndices': [draw['instanceIndex'] for draw in blocked],
            'reason': 'bc3-alpha-rule-missing',
            'rule': 'cab01alphas_diff is DXT5/BC3; no alpha-test or blend rule is declared, so the draw is not bound',
        },
        'textures': sorted(texture_sources.values(), key=lambda item: (item['block'], item['index'])),
        'inputs': inputs,
        'limits': [
            'no rendered result, GPU upload, browser check or full-game claim',
            'only the static g_tAlbedo image identity is resolved; g_tMaterial, material colour, blend state, shader stages, sampler wrap/filter and mips are not applied',
            'the four cab draws stay blocked as bc3-alpha-rule-missing until an alpha rule is declared and verified',
            'source images are 32x16 BC1 and 16x16 BC3 at mip0; no upscale or invented texture',
        ],
    }
    text = json.dumps(artifact, sort_keys=True, indent=2, ensure_ascii=False, allow_nan=False) + '\n'
    artifact_path = out_dir / 'level-instance-textures.json'
    artifact_path.write_text(text, encoding='utf-8')

    # A second write is the determinism check required by the task card.
    repeat_path = out_dir / 'repeat-level-instance-textures.json'
    repeat_uv = out_dir / 'repeat-level-instance-uv.bin'
    repeat_path.write_text(text, encoding='utf-8')
    repeat_uv.write_bytes(uv_bytes)
    artifact_sha = sha256_bytes(artifact_path.read_bytes())
    repeat_sha = sha256_bytes(repeat_path.read_bytes())
    if artifact_sha != repeat_sha:
        raise SystemExit('repeated artifact build is not byte-identical')
    if sha256_bytes(uv_path.read_bytes()) != sha256_bytes(repeat_uv.read_bytes()):
        raise SystemExit('repeated UV0 build is not byte-identical')

    summary = {
        'artifact': str(artifact_path.relative_to(ROOT)),
        'artifactSha256': artifact_sha,
        'uvFile': str(uv_path.relative_to(ROOT)),
        'uvSha256': sha256_bytes(uv_path.read_bytes()),
        'uvValues': len(native['uv0']),
        'uvBytes': len(uv_bytes),
        'uvAggregate': native['metadata']['uv0Aggregate'],
        'draws': len(draws),
        'triangles': sum(draw['triangleCount'] for draw in draws),
        'bindableBc1': {'draws': bc1_draws, 'triangles': bc1_triangles},
        'blockedBc3': {'draws': bc3_draws, 'triangles': bc3_triangles, 'reason': 'bc3-alpha-rule-missing'},
        'textures': [{'block': texture['block'], 'index': texture['index'], 'name': texture['name'],
                      'formatName': texture['formatName'], 'draws': len(texture['draws'])}
                     for texture in sorted(texture_sources.values(), key=lambda item: (item['block'], item['index']))],
        'repeatArtifactSha256': repeat_sha,
        'deterministic': True,
    }
    (out_dir / 'level-instance-textures-summary.json').write_text(
        json.dumps(summary, sort_keys=True, indent=2, allow_nan=False) + '\n', encoding='utf-8')
    return artifact, summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out-dir', type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()
    artifact, summary = build(args.out_dir)
    print(json.dumps({'artifact': summary['artifact'], 'sha256': summary['artifactSha256'],
                      'uvSha256': summary['uvSha256'], 'uvValues': summary['uvValues'],
                      'uvBytes': summary['uvBytes'], 'draws': summary['draws'],
                      'bindableBc1': summary['bindableBc1'], 'blockedBc3': summary['blockedBc3'],
                      'textures': summary['textures'], 'deterministic': summary['deterministic']},
                     indent=2, sort_keys=True))


if __name__ == '__main__':
    main()
