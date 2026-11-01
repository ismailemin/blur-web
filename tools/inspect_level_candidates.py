"""Find source-correlated level draw pairs supported by the current preview reader.

Only first LOD0 source records are considered. Geometry/node associations come
from the first RenderList's declared POSITION and index source lists, never from
an all-pairs search or a whole-index-buffer topology guess.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import hashlib
import json
import math
from pathlib import Path
import struct
import subprocess

from inspect_car_level_assets import Reader, render_layout, resource_prefix, stream_prefix
from inspect_level_chunk import geometry, read_render_lists

ROOT = Path(__file__).resolve().parent.parent
LIMIT = 16 * 1024 * 1024
LEVELS = ('usa_la_river', 'showroom', 'spa_barcelona_bowl_multiplayer')


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical_mesh(report: dict) -> tuple[str, str]:
    # C++ JSON may contain integer-token -0; preserve it when parsing (below).
    positions = b''.join(struct.pack('<f', value) for value in report['positions'])
    indices = b''.join(struct.pack('<I', value) for value in report['indices'])
    return digest(positions), digest(indices)


def json_floats(text: str):
    return json.loads(text, parse_int=lambda value: -0.0 if value == '-0' else int(value))


def flatness(mesh: dict) -> dict:
    """Geometry-only diagnostic, not an original asset semantic classification."""
    positions, indices = mesh['positions'], mesh['indices']
    total_area = horizontal_area = 0.0
    for at in range(0, len(indices), 3):
        a, b, c = (positions[index * 3:index * 3 + 3] for index in indices[at:at + 3])
        u = [b[k] - a[k] for k in range(3)]
        v = [c[k] - a[k] for k in range(3)]
        cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
        length = math.sqrt(sum(value * value for value in cross))
        total_area += length / 2
        if length and abs(cross[1]) / length >= 0.85:
            horizontal_area += length / 2
    bounds = mesh['bounds']
    extent = [bounds['max'][k] - bounds['min'][k] for k in range(3)]
    fraction = horizontal_area / total_area if total_area else 0.0
    return {'extentXYZ': extent, 'triangleArea': total_area,
            'upFacingAreaFraction': fraction, 'horizontalTriangleArea': horizontal_area,
            'interpretation': 'Geometry-only floor/road-like score; roofs and other flat surfaces can also score highly'}


def source_blocks(scene: dict, render: dict) -> dict[int, int]:
    """Correlate primary declared POSITION + IB sources; value is input index count."""
    scores = Counter()
    for primitive in render['primitives']:
        declaration = primitive['declaration']
        if not 0 <= declaration < len(scene['declarations']):
            raise ValueError('Primitive declaration outside table')
        elements = [e for e in scene['declarations'][declaration] if e['usage'] == 0 and e['usageIndex'] == 0]
        if len(elements) != 1:
            raise ValueError('Non-unique POSITION declaration')
        streams = [stream for stream in primitive['streams'] if stream['streamIndex'] == elements[0]['stream']]
        if len(streams) != 1:
            raise ValueError('Non-unique POSITION binding')
        stream = streams[0]
        if stream['frequency']:
            continue
        vb_slot, ib_slot = stream['vertexBuffer'], primitive['indexBuffer']
        vbs, ibs = render['sources']['vertexBuffer'], render['sources']['indexBuffer']
        if not 0 <= vb_slot < len(vbs) or not 0 <= ib_slot < len(ibs):
            raise ValueError('Primitive source slot outside node table')
        vb, ib = vbs[vb_slot], ibs[ib_slot]
        if vb['block'] < 0 or vb['block'] != ib['block'] or not primitive['lods']:
            continue
        scores[vb['block']] += primitive['lods'][0]['indexCount']
    return dict(scores)


def inspect_level(name: str, statistics: dict, errors: list) -> tuple[list, dict]:
    folder = ROOT / 'game-data/Blur/levels' / name
    level_file, stream_file = folder / 'level.levelrender', folder / 'level.levelstream'
    if not level_file.is_file() or not stream_file.is_file():
        return [], {'level': name, 'error': 'Level files absent'}
    if level_file.stat().st_size > LIMIT:
        return [], {'level': name, 'error': 'Level header exceeds16MiB limit'}
    data = level_file.read_bytes()
    scene = render_layout(data, 'level')['scene']
    records = scene['stream']['chunks']
    stream_size = stream_file.stat().st_size
    geometry_records = defaultdict(list)
    nodes = []

    def read_record(record, prefix=False):
        offset, count = record['offset'], record['storedBytes']
        if offset < 0 or count < 40 or count > LIMIT or offset + count > stream_size:
            raise ValueError('Stream range outside input/bounded chunk limit')
        with stream_file.open('rb') as file:
            file.seek(offset)
            result = file.read(min(count, 64) if prefix else count)
        if len(result) != (min(count, 64) if prefix else count):
            raise ValueError('Short stream read')
        statistics['bytesRead'] += len(result)
        return result

    for chunk_index, record in enumerate(records):
        if not record['items'] or record['items'][0]['lod'] != 0:
            statistics['notFirstLOD0'] += 1
            continue
        if record['prerequisites']:
            statistics['requiresPrerequisites'] += 1
            continue
        try:
            prefix = read_record(record, True)
            info = stream_prefix(prefix, record)
            first_vbs = info.get('firstVertexBufferCount', 0)
            if first_vbs:
                geometry_records[record['items'][0]['block']].append((chunk_index, record))
                continue
            # A node-only first resource must have no VB and no IB. These two
            # source vector headers are fixed after the validated ARCH prefix.
            r = Reader(prefix, 48)
            if r.vec() != 0 or r.vec() == 0:
                statistics['neitherGeometryNorNode'] += 1
                continue
            raw = read_record(record)
            resources = resource_prefix(raw, {'resourcePayloadOffset': 24, 'scenePayloadOffset': 0}, streamed=True)
            render_lists = read_render_lists(raw, resources)
            if not render_lists:
                statistics['noRenderList'] += 1
                continue
            first = render_lists[0]
            # Native currently consumes only the first supported RenderList,
            # so later render lists must not inflate its candidate score.
            scores = source_blocks(scene, first)
            nodes.append({'chunkIndex': chunk_index, 'record': record, 'raw': raw,
                          'resources': resources, 'render': first, 'scores': scores})
            statistics['nodeChunksParsed'] += 1
        except (ValueError, IndexError, StopIteration, struct.error) as error:
            errors.append({'level': name, 'chunk': chunk_index, 'stage': 'node-prefix', 'error': str(error)})

    pairs = []
    for node in nodes:
        for block, estimated in node['scores'].items():
            matches = geometry_records.get(block, [])
            if len(matches) != 1:
                statistics['missingOrAmbiguousGeometry'] += 1
                continue
            chunk_index, record = matches[0]
            pairs.append({'level': name, 'levelFile': level_file, 'levelSha256': digest(data),
                          'scene': scene, 'node': node, 'geometryBlock': block,
                          'geometryChunkIndex': chunk_index, 'geometryRecord': record,
                          'estimatedSourceIndexCount': estimated, 'readRecord': read_record})
    summary = {'level': name, 'sourceChunks': len(records), 'correlatedPairs': len(pairs),
               'nodeChunksParsed': len(nodes), 'geometryBlocks': len(geometry_records),
               'levelRenderBytes': len(data), 'streamBytes': stream_size}
    return pairs, summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out-dir', type=Path, default=ROOT / '_work/level-candidates')
    parser.add_argument('--max-probes', type=int, default=30)
    args = parser.parse_args()
    if not 1 <= args.max_probes <= 30:
        parser.error('Native probe limit must be1..30')
    out = args.out_dir.resolve()
    if out.is_relative_to((ROOT / 'game-data/Blur').resolve()):
        parser.error('Output must be outside game data')
    out.mkdir(parents=True, exist_ok=True)
    executable = ROOT / '_work/build/asset-reader-native/Release/level_inspect.exe'
    if not executable.is_file():
        parser.error('Build the native level_inspect CLI first')
    statistics = Counter()
    errors, summaries, all_pairs = [], [], []
    # Each level receives up to ten source-correlated probes; this prevents a
    # large river scene monopolizing the entire 30-probe budget.
    for name in LEVELS:
        pairs, summary = inspect_level(name, statistics, errors)
        summaries.append(summary)
        all_pairs.extend(sorted(pairs, key=lambda pair: pair['estimatedSourceIndexCount'], reverse=True)[:10])
    all_pairs.sort(key=lambda pair: pair['estimatedSourceIndexCount'], reverse=True)
    valid, probes = [], []
    for number, pair in enumerate(all_pairs[:args.max_probes]):
        name, node, block = pair['level'], pair['node'], pair['geometryBlock']
        record = pair['geometryRecord']
        probe = {'level': name, 'geometryBlock': block, 'geometryChunkIndex': pair['geometryChunkIndex'],
                 'nodeBlock': node['record']['items'][0]['block'], 'nodeChunkIndex': node['chunkIndex'],
                 'estimatedSourceIndexCount': pair['estimatedSourceIndexCount']}
        try:
            raw = pair['readRecord'](record)
            resources = resource_prefix(raw, {'resourcePayloadOffset': 24, 'scenePayloadOffset': 0}, streamed=True)
            if resources['nodeCount']:
                raise ValueError('First geometry resource also has node payloads; native subset rejects mixed blocks')
            r = Reader(raw, resources['firstNodeOffset'])
            if r.unpack('I'):
                raise ValueError('First geometry resource has textures; native subset does not consume them')
            reference = geometry(raw, resources, pair['scene'], node['render'], block)
            stage = out / 'probes' / f'{number:02d}-{name}-g{block}-n{probe["nodeBlock"]}'
            stage.mkdir(parents=True, exist_ok=True)
            geometry_file, node_file = stage / 'geometry.chunk', stage / 'node.chunk'
            geometry_file.write_bytes(raw)
            node_file.write_bytes(node['raw'])
            process = subprocess.run([str(executable), str(pair['levelFile']), str(geometry_file), str(node_file), str(block), str(probe['nodeBlock'])],
                                     capture_output=True, text=True, encoding='utf-8', timeout=30, check=False)
            statistics['nativeProbes'] += 1
            native = json_floats(process.stdout)
            if process.returncode != 0 or native.get('status') != 'ok':
                raise ValueError('Native: ' + native.get('error', process.stderr[:200]))
            position_hash, index_hash = canonical_mesh(native)
            if position_hash != reference['positionsFloat32LESha256'] or index_hash != reference['indicesUint32LESha256']:
                raise ValueError('Independent Python/native geometry hash mismatch')
            if len(native['draws']) != len(reference['draws']):
                raise ValueError('Independent Python/native draw-count mismatch')
            score = flatness(reference)
            evidence = {**probe, 'status': 'ok', 'vertexCount': reference['vertexCount'], 'triangleCount': reference['triangleCount'],
                        'drawCount': len(reference['draws']), 'nodeName': node['render']['name'],
                        'bounds': reference['bounds'], 'flatness': score,
                        'geometryRange': {k: record[k] for k in ('offset', 'storedBytes', 'logicalBytes')},
                        'nodeRange': {k: node['record'][k] for k in ('offset', 'storedBytes', 'logicalBytes')},
                        'levelRenderSha256': pair['levelSha256'], 'geometryChunkSha256': digest(raw), 'nodeChunkSha256': digest(node['raw']),
                        'positionsFloat32LESha256': position_hash, 'indicesUint32LESha256': index_hash,
                        'independentNativeGeometryEqual': True, 'instancesApplied': False,
                        'stageDirectory': str(stage)}
            (stage / 'reference.json').write_text(json.dumps(reference) + '\n', encoding='utf-8')
            valid.append(evidence)
            probes.append({**probe, 'status': 'ok', 'vertices': reference['vertexCount'], 'triangles': reference['triangleCount']})
        except (ValueError, IndexError, StopIteration, struct.error, json.JSONDecodeError, subprocess.TimeoutExpired) as error:
            probes.append({**probe, 'status': 'unsupported', 'error': str(error)})

    # Rank by real horizontal area first, then real triangle count. This is an
    # explicit geometry-based selection, not a semantic claim that it is a road.
    valid.sort(key=lambda row: (row['flatness']['horizontalTriangleArea'], row['triangleCount']), reverse=True)
    top = valid[:3]
    report = {'scope': 'First resource LOD0 / first RenderList direct primitives; no instances, materials or full level import',
              'selectionMeaning': 'Floor/road-like geometry is inferred only from triangle orientation and area; no semantic road confirmation',
              'statistics': dict(statistics), 'levels': summaries, 'correlatedPairsConsidered': len(all_pairs),
              'nativeProbeBudget': args.max_probes, 'probes': probes, 'topCandidates': top,
              'validCandidateCount': len(valid), 'allValidCandidateSummaries': valid, 'parseErrors': errors[:50], 'parseErrorCount': len(errors)}
    (out / 'report.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    manifest = {'scope': report['scope'], 'selectionMeaning': report['selectionMeaning'],
                'statistics': report['statistics'], 'candidates': top}
    (out / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'statistics': report['statistics'], 'levels': summaries, 'validCandidates': len(valid),
                      'topCandidates': [{key: row[key] for key in ('level', 'geometryBlock', 'nodeBlock', 'vertexCount', 'triangleCount', 'drawCount', 'bounds', 'flatness', 'stageDirectory')} for row in top],
                      'unsupportedReasons': dict(Counter(row['error'] for row in probes if row['status'] != 'ok')),
                      'parseErrors': len(errors)}, indent=2))


if __name__ == '__main__':
    main()
