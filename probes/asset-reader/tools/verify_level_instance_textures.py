"""Independent verifier for the P73a level-instance UV/material artifact.

Re-derives the 22 draws from the original source with the Python reference,
re-hashes the exported UV0 stream, re-joins the P34/P47 texture registry and
checks the 18 BC1-bindable / 4 BC3-blocked split. It does not rebuild the artifact.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'probes/asset-reader/tests'))
from verify_instance_textures_reference import build_reference  # noqa: E402

DEFAULT_DIR = ROOT / '_work/asset-reader'
ARTIFACT = 'level-instance-textures.json'
REPEAT = 'repeat-level-instance-textures.json'
SUMMARY = 'level-instance-textures-summary.json'
UV = 'level-instance-uv.bin'
REPEAT_UV = 'repeat-level-instance-uv.bin'
REGISTRY = ROOT / '_work/logs/engine-stream-spike/engine-textures.json'
BC1 = 827611204
BC3 = 894720068
NAMES = {1073: 'car01_lic_diff', 1112: 'car02_lic_diff', 1118: 'car03_lic_diff',
         1074: 'bigtruck02_diff', 1205: 'cab01alphas_diff'}


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_path(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1 << 20), b''):
            digest.update(block)
    return digest.hexdigest()


class Checker:
    def __init__(self):
        self.passed = 0
        self.failed = []

    def check(self, condition, label):
        if condition:
            self.passed += 1
        else:
            self.failed.append(label)
            print('FAIL: ' + label)

    def finish(self):
        print(json.dumps({'checks': self.passed, 'failures': len(self.failed),
                          'status': 'PASS' if not self.failed else 'FAIL'}, indent=2))
        return 0 if not self.failed else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dir', type=Path, default=DEFAULT_DIR)
    args = parser.parse_args()
    directory = args.dir
    check = Checker()

    artifact_path = directory / ARTIFACT
    repeat_path = directory / REPEAT
    summary_path = directory / SUMMARY
    uv_path = directory / UV
    repeat_uv_path = directory / REPEAT_UV
    for path in (artifact_path, repeat_path, summary_path, uv_path, repeat_uv_path):
        check.check(path.exists(), f'missing artifact {path}')
    if check.failed:
        return check.finish()

    artifact = json.loads(artifact_path.read_text(encoding='utf-8'))
    summary = json.loads(summary_path.read_text(encoding='utf-8'))
    reference = build_reference()
    registry = json.loads(REGISTRY.read_text(encoding='utf-8'))
    registry_by_source = {(item['block'], item['index']): item for item in registry['textures']}

    check.check(artifact.get('kind') == 'asset-reader.level-instance-textures', 'artifact kind')
    check.check(artifact.get('version') == 1, 'artifact version')
    check.check(artifact.get('level') == 'usa_la_river', 'level name')
    check.check(artifact.get('nodeBlock') == 253 and artifact.get('geometryBlock') == 27, 'source block identity')

    # Determinism: the second build is byte-identical for both text and UV bytes.
    check.check(artifact_path.read_bytes() == repeat_path.read_bytes(), 'repeat artifact is byte-identical')
    check.check(uv_path.read_bytes() == repeat_uv_path.read_bytes(), 'repeat UV0 file is byte-identical')
    check.check(summary.get('deterministic') is True, 'summary marks deterministic')
    check.check(summary.get('artifactSha256') == sha256_path(artifact_path), 'summary artifact hash')
    check.check(summary.get('repeatArtifactSha256') == sha256_path(repeat_path), 'summary repeat hash')

    # UV stream.
    uv_bytes = uv_path.read_bytes()
    uv_values = struct.unpack('<%df' % (len(uv_bytes) // 4), uv_bytes)
    uv = artifact['uv0']
    check.check(len(uv_bytes) == 105296, 'UV0 byte length is 105,296')
    check.check(len(uv_values) == 26324, 'UV0 value count is 26,324')
    check.check(uv['values'] == 26324 and uv['bytes'] == 105296, 'UV0 artifact counts')
    check.check(sha256_bytes(uv_bytes) == uv['sha256'], 'UV0 artifact SHA-256')
    check.check(uv['sha256'] == reference['uvSha256'], 'UV0 SHA-256 matches independent Python')
    check.check(uv['aggregate'] == reference['uvAggregate'], 'UV0 aggregate matches independent Python')
    check.check(uv['declaration'] == {'usage': 5, 'usageIndex': 0, 'type': 8, 'offset': 16, 'stride': 20},
                'UV0 declaration (usage 5 / type 8 / offset 16 / stride 20)')
    check.check(all(value == value and abs(value) != float('inf') for value in uv_values), 'UV0 stream is finite')

    # Mesh reference.
    mesh = artifact['mesh']
    reader_path = ROOT / mesh['readerOutput']
    check.check(reader_path.exists(), 'mesh reader output exists')
    if reader_path.exists():
        reader = json.loads(reader_path.read_text(encoding='utf-8'))
        positions = struct.pack('<%df' % len(reader['positions']), *reader['positions'])
        indices = struct.pack('<%dI' % len(reader['indices']), *reader['indices'])
        check.check(mesh['readerOutputSha256'] == sha256_path(reader_path), 'mesh reader output SHA-256')
        check.check(mesh['positionsSha256'] == sha256_bytes(positions), 'mesh positions SHA-256')
        check.check(mesh['indicesSha256'] == sha256_bytes(indices), 'mesh indices SHA-256')
        check.check(mesh['vertexCount'] == 13162 and mesh['triangleCount'] == 10308, 'mesh count identity')
        check.check(len(reader['uv0']) == 26324, 'reader UV0 count')

    # Per-draw identity and spans.
    draws = artifact['draws']
    check.check(len(draws) == 22, 'artifact has 22 draws')
    check.check(len(draws) == len(reference['draws']), 'artifact/Python draw count')
    for index, (draw, source) in enumerate(zip(draws, reference['draws'])):
        check.check(draw['instanceIndex'] == source['instanceIndex'], f'draw {index} instance index')
        check.check(draw['basePrimitiveIndex'] == source['basePrimitiveIndex'], f'draw {index} base primitive')
        check.check(draw['firstIndex'] == source['firstIndex'], f'draw {index} first index')
        check.check(draw['indexCount'] == source['indexCount'], f'draw {index} index count')
        check.check(draw['triangleCount'] == source['triangleCount'], f'draw {index} triangle count')
        check.check(draw['uvHash'] == source['uvHash'], f'draw {index} UV0 hash')
        check.check(draw['uvType'] == 8 and draw['uvOffset'] == 16 and draw['uvStride'] == 20, f'draw {index} UV0 layout')
        check.check(draw['uv0Available'] is True, f'draw {index} UV0 available')
        check.check(draw['material'] == source['material'], f'draw {index} material name')
        check.check(draw['materialRow'] == source['materialRow'], f'draw {index} material row')
        check.check(draw['albedoParameter'] == 'g_tAlbedo', f'draw {index} albedo parameter')
        check.check(draw['resourceBlock'] == source['resourceBlock'], f'draw {index} resource block')
        check.check(draw['resourceIndex'] == source['resourceIndex'], f'draw {index} resource index')
        check.check(draw['albedoTextureId'] == f'level.albedo.{source["resourceBlock"]}.{source["resourceIndex"]}',
                    f'draw {index} texture identity')
        check.check(draw['albedoTexture'] == NAMES[draw['resourceBlock']], f'draw {index} albedo texture name')
        texture = registry_by_source.get((draw['resourceBlock'], draw['resourceIndex']))
        check.check(texture is not None, f'draw {index} registry texture')
        if texture:
            check.check(draw['texture']['name'] == texture['name'] == NAMES[draw['resourceBlock']],
                        f'draw {index} texture name')
            check.check(draw['texture']['format'] == texture['format'], f'draw {index} texture format')
            check.check(draw['texture']['rgbaFnv1a64'] == texture['rgbaHash'], f'draw {index} RGBA hash')
        if texture and texture['format'] == BC1:
            check.check(draw['bindable'] is True, f'draw {index} BC1 bindable')
            check.check(draw['bindingStatus'] == 'bindable-bc1', f'draw {index} bindable status')
            check.check(draw['blockedReason'] is None, f'draw {index} BC1 has no blocker')
        else:
            check.check(draw['bindable'] is False, f'draw {index} BC3 blocked')
            check.check(draw['bindingStatus'] == 'blocked', f'draw {index} blocked status')
            check.check(draw['blockedReason'] == 'bc3-alpha-rule-missing', f'draw {index} BC3 blocker token')

    bindable = artifact['bindable']
    blocked = artifact['blocked']
    check.check(bindable['draws'] == 18 and bindable['triangles'] == 10212, '18 BC1 draws / 10,212 triangles')
    check.check(blocked['draws'] == 4 and blocked['triangles'] == 96, '4 BC3 draws / 96 triangles')
    check.check(blocked['reason'] == 'bc3-alpha-rule-missing', 'blocked reason token')
    check.check(sum(draw['triangleCount'] for draw in draws) == 10308, '22 draws / 10,308 triangles')
    check.check(len(bindable['instanceIndices']) == 18 and len(blocked['instanceIndices']) == 4, 'split instance indices')
    check.check(blocked['instanceIndices'] == [14, 15, 19, 20], 'BC3 instance indices')

    # Five source images.
    textures = artifact['textures']
    check.check(len(textures) == 5, 'five level albedo sources')
    check.check(sorted((item['block'], item['index']) for item in textures) ==
                sorted((item['block'], item['index']) for item in registry_by_source.values()
                       if item['block'] in NAMES), 'five registry source identities')
    for source in textures:
        check.check(source['name'] == NAMES[source['block']], f'source {source["block"]} name')
        texture = registry_by_source[(source['block'], source['index'])]
        check.check(source['format'] == texture['format'], f'source {source["block"]} format')
        check.check(source['formatName'] == ('DXT1/BC1' if texture['format'] == BC1 else 'DXT5/BC3'),
                    f'source {source["block"]} format name')
        check.check(source['rgbaFnv1a64'] == texture['rgbaHash'], f'source {source["block"]} RGBA hash')
        check.check(source['triangles'] == sum(draw['triangleCount'] for draw in draws
                                                if draw['resourceBlock'] == source['block'] and
                                                draw['resourceIndex'] == source['index']),
                    f'source {source["block"]} triangle total')
    check.check({source['block'] for source in textures} == set(NAMES), 'source block set')

    # Input hashes.
    for key in ('levelRender', 'levelStream', 'geometryChunk', 'nodeChunk', 'textureRegistry'):
        item = artifact['inputs'][key]
        path = ROOT / item['path']
        check.check(path.exists(), f'input {key} exists')
        if path.exists():
            check.check(item['sha256'] == sha256_path(path), f'input {key} SHA-256')

    return check.finish()


if __name__ == '__main__':
    raise SystemExit(main())
