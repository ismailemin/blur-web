"""Source-correlated original Corvette resource textures and streaming mip tails.

Writes only local evidence. Original PC descriptors are copied byte-for-byte;
later top-mip payloads are never passed off as complete mip chains.
"""
from __future__ import annotations
import argparse
import hashlib
import io
import json
from pathlib import Path
import struct
import subprocess
import inspect_car_level_assets as car
import inspect_car_materials as materials

ROOT = Path(__file__).resolve().parent.parent
MODEL_SHA256 = '77840511e5ca416ff9e7cbdc9ee9fc960fce0205f83c9be77e0803607c32cb9d'
FORMATS = {int.from_bytes(b'DXT1', 'little'): 8,
           int.from_bytes(b'DXT3', 'little'): 16,
           int.from_bytes(b'DXT5', 'little'): 16}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def mip_sizes(desc):
    if (desc['format'] not in FORMATS or desc['depth'] != 1 or desc['type'] != 3
            or not 1 <= desc['width'] <= 512 or not 1 <= desc['height'] <= 512
            or not 1 <= desc['levels'] <= 10):
        raise ValueError('Texture outside bounded 2D BC diagnostic')
    return [max(1, (max(1, desc['width'] >> level)+3)//4)
            * max(1, (max(1, desc['height'] >> level)+3)//4)
            * FORMATS[desc['format']] for level in range(desc['levels'])]


def assemble(data, lod, previous):
    if lod['present'] != 1 or lod['headerBytes'] != 28:
        raise ValueError('Only present unpaired PC descriptors supported')
    desc = lod['descriptor']
    sizes = mip_sizes(desc)
    header = data[lod['headerOffset']:lod['headerOffset']+28]
    if struct.unpack('<7I', header) != tuple(desc[key] for key in
            ('width', 'height', 'depth', 'levels', 'format', 'usage', 'type')):
        raise ValueError('Parsed descriptor differs from source bytes')
    payload = data[lod['dataOffset']:lod['dataOffset']+lod['dataBytes']]
    if len(payload) != lod['dataBytes']:
        raise ValueError('Truncated source payload')
    # LoadTextureData2D consumes an exact prefix of whole top mip levels.
    covered = 0
    prefix_levels = 0
    for size in sizes:
        if covered == len(payload):
            break
        covered += size
        prefix_levels += 1
        if covered > len(payload):
            raise ValueError('Source payload ends within a mip')
    if covered != len(payload):
        raise ValueError('Source payload exceeds descriptor mip chain')
    chain = bytearray(sum(sizes))
    chain[:len(payload)] = payload
    segments = [{'kind': 'new-top-mips', 'modelOffset': lod['dataOffset'],
                 'bytes': len(payload), 'destinationOffset': 0,
                 'sha256': sha(payload)}]
    if len(payload) != len(chain):
        if previous is None:
            raise ValueError('Partial initial texture has no existing mip tail')
        old, old_chain = previous
        difference = desc['levels']-old['levels']
        if (difference < 0 or desc['format'] != old['format']
                or max(1, desc['width'] >> difference) != old['width']
                or max(1, desc['height'] >> difference) != old['height']
                or sizes[difference:] != mip_sizes(old)):
            raise ValueError('Source mip tail dimensions/format do not align')
        destination = sum(sizes[:difference])
        if destination != len(payload) or len(old_chain) != len(chain)-destination:
            raise ValueError('Source top mip prefix and copied tail overlap or leave a gap')
        chain[destination:] = old_chain
        segments.append({'kind': 'previous-complete-mip-tail',
                         'bytes': len(old_chain), 'destinationOffset': destination,
                         'sha256': sha(old_chain)})
    return header+chain, (desc, bytes(chain)), segments, prefix_levels


def decode_pillow(desc, chain):
    from PIL import Image
    # Standard DDS wrapper for independent decoding; descriptor dimensions/format
    # are original. This wrapper is not emitted as a changed game descriptor.
    header = [124, 0x1007, desc['height'], desc['width'], 0, 0, 1]+[0]*11
    header += [32, 4, desc['format'], 0, 0, 0, 0, 0, 0x1000, 0, 0, 0, 0]
    return Image.open(io.BytesIO(b'DDS '+struct.pack('<31I', *header)+chain)).convert('RGBA')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, default=ROOT/'_work/car-level-assets/corvette_c3_race.model.decoded')
    parser.add_argument('--out-dir', type=Path, default=ROOT/'_work/car-resource-textures')
    parser.add_argument('--native-cli', type=Path, default=ROOT/'_work/build/asset-reader-native/Release/texture_inspect.exe')
    args = parser.parse_args()
    data = args.input.read_bytes()
    if sha(data) != MODEL_SHA256:
        raise ValueError('Diagnostic is scoped to the independently identified Corvette fixture')
    out = args.out_dir.resolve()
    if out.is_relative_to((ROOT/'game-data').resolve()) or out.is_relative_to((ROOT/'upstream').resolve()):
        parser.error('Evidence output cannot be inside game/source data')
    out.mkdir(parents=True, exist_ok=True)
    old_reader = car.Reader
    try:
        car.Reader = materials.MaterialReader
        layout = car.render_layout(data, 'model')
    finally:
        car.Reader = old_reader
    scene_end = next(chunk['end'] for chunk in layout['chunks'] if chunk['id']=='Scene')
    blocks = materials.resource_blocks(data, layout['scene'], scene_end)
    resolved = json.loads((ROOT/'_work/car-materials/corvette-materials.json').read_text())
    if resolved['sha256'] != MODEL_SHA256:
        raise ValueError('Material report model mismatch')
    targets = {}
    for draw in resolved['draws']:
        if draw['status'] != 'static_albedo_image_resolved':
            continue
        texture = draw['knownTextures']['g_MeshTexture']['texture']
        if texture['kind'] == 'resource-block':
            key = (texture['block'], texture['index'])
            targets.setdefault(key, {'name': texture['name'], 'draws': []})['draws'].append(draw['draw'])
    if len(targets) != 2 or sum(len(value['draws']) for value in targets.values()) != 12:
        raise ValueError('Expected two resource images supplying twelve static draws')
    results = []
    rejected = []
    for (block_index, texture_index), target in sorted(targets.items()):
        texture = blocks[block_index]['textures'][texture_index]
        if texture['name'] != target['name']:
            raise ValueError('Fresh source traversal differs from material report')
        previous = None
        records = []
        for lod in texture['lods']:
            if not lod['present']:
                records.append({'lod': lod['lod'], 'present': False, 'lastAvailableLod': records[-1].get('lastAvailableLod', records[-1]['lod']) if records else None})
                continue
            prior = previous
            raw, previous, segments, top_levels = assemble(data, lod, previous)
            cases = [('partial-mip', {**lod, 'dataBytes': lod['dataBytes']-1}, prior)]
            if prior is not None:
                cases += [('missing-tail', lod, None),
                          ('incompatible-tail-dimensions', lod,
                           ({**prior[0], 'width': prior[0]['width']*2}, prior[1]))]
            for name, bad_lod, bad_previous in cases:
                try:
                    assemble(data, bad_lod, bad_previous)
                except ValueError:
                    rejected.append(f"{target['name']}/lod{lod['lod']}/{name}")
                else:
                    raise ValueError(f'Invalid mip assembly accepted: {name}')
            desc, chain = previous
            stem = f"{target['name']}-lod{lod['lod']}"
            raw_path = out/f'{stem}.rawtexture'
            raw_path.write_bytes(raw)
            image = decode_pillow(desc, chain)
            rgba = image.tobytes()
            image.save(out/f'{stem}.png')
            (out/f'{stem}.rgba').write_bytes(rgba)
            record = {'lod': lod['lod'], 'present': True, 'descriptor': desc,
                      'headerOffset': lod['headerOffset'], 'headerBytes': 28,
                      'descriptorSha256': sha(raw[:28]), 'originalDescriptorPreserved': True,
                      'newPayloadOffset': lod['dataOffset'], 'newPayloadBytes': lod['dataBytes'],
                      'completeMipBytes': len(chain), 'topMipLevelsInPayload': top_levels,
                      'sourceSegments': segments, 'rawtexture': str(raw_path.relative_to(ROOT)),
                      'rawtextureSha256': sha(raw), 'independentPillowRgbaSha256': sha(rgba)}
            if args.native_cli.is_file():
                native = json.loads(subprocess.check_output([str(args.native_cli), str(raw_path), '--raw'], text=True))
                if native['status'] != 'ok' or (native['width'],native['height']) != image.size:
                    raise ValueError('Native decoder rejected an independently assembled chain')
                native_rgba = bytes(native['rgba'])
                if len(native_rgba) != len(rgba):
                    raise ValueError('Native decoder output size differs')
                differences = [(i, abs(a-b)) for i,(a,b) in enumerate(zip(native_rgba,rgba)) if a!=b]
                if any(not(desc['format']==int.from_bytes(b'DXT5','little') and i%4==3 and delta<=1) for i,delta in differences):
                    raise ValueError('Native/Pillow difference beyond documented BC3 alpha rounding')
                record['nativeComparison'] = {'differentChannels': len(differences),
                    'maxDifference': max((delta for _,delta in differences),default=0),
                    'nativeRgbaSha256': sha(native_rgba),
                    'policy': 'exact except BC3 alpha rounded source interpolation versus Pillow floor, <=1'}
            records.append(record)
        results.append({'block': block_index, 'texture': texture_index, **target, 'lods': records})
    report = {'modelSha256': MODEL_SHA256, 'textures': results,
              'scope': 'Two original static resource image inputs for twelve direct draws; complete shader/runtime appearance is not reproduced',
              'sourceSceneEnd': scene_end, 'independentDecoder': 'Pillow DDS',
              'invalidAssemblyCasesRejected': rejected}
    (out/'report.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'textures': len(results), 'draws': 12,
        'assembledLods': sum(sum(lod['present'] for lod in result['lods']) for result in results),
        'nativeComparisons': sum('nativeComparison' in lod for result in results for lod in result['lods']),
        'invalidAssemblyCasesRejected': len(rejected),
        'report': str((out/'report.json').relative_to(ROOT))},indent=2))


if __name__ == '__main__':
    main()
