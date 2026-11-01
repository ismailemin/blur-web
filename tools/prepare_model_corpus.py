"""Prepare a deterministic bounded local model corpus; never changes game data."""
from __future__ import annotations

import argparse
import hashlib
import json
import struct
import zlib
from collections import defaultdict, deque
from pathlib import Path

from inspect_asset_layout import pak_index

MAX_BYTES = 65536
TRAFFIC = r'\models\objects\usa_la_river\misc\trafficcylinder.model'


def decode_packet(packed: bytes, logical: int) -> bytes:
    if not 1 <= logical <= MAX_BYTES or not 8 <= len(packed) <= MAX_BYTES + 8:
        raise ValueError('Packet exceeds bounded single-packet scope')
    size, stored = struct.unpack_from('<II', packed)
    if size != MAX_BYTES:
        raise ValueError('Unexpected packet size')
    if stored == 0xffffffff:
        if len(packed) != MAX_BYTES + 8:
            raise ValueError('Truncated raw packet')
        return packed[8:8 + logical]
    if not 0 < stored <= MAX_BYTES or stored + 8 != len(packed):
        raise ValueError('Compressed packet bounds mismatch')
    inflater = zlib.decompressobj(-15)
    decoded = inflater.decompress(packed[8:], logical + 1)
    if len(decoded) != logical or not inflater.eof or inflater.unused_data or inflater.unconsumed_tail:
        raise ValueError('Decoded length/stream termination mismatch')
    return decoded


def chunks(data: bytes, start: int, end: int, depth: int = 0) -> list[dict]:
    if depth > 8:
        raise ValueError('Chunk nesting exceeds diagnostic scope')
    result = []
    while start < end:
        if end - start < 16:
            raise ValueError('Truncated chunk header')
        name, size, count, kind, compression = struct.unpack_from('<8sIHbb', data, start)
        if size < 16 or start + size > end or kind not in (0x41, 0x43):
            raise ValueError('Invalid chunk bounds/type')
        name = name.rstrip(b'\0').decode('ascii')
        record = dict(id=name, offset=start, bytes=size, count=count, type=kind, compression=compression, children=[])
        if kind == 0x43:
            if compression:
                raise ValueError('Compressed container unsupported')
            record['children'] = chunks(data, start + 16, start + size, depth + 1)
            if len(record['children']) != count:
                raise ValueError('Container child count mismatch')
        result.append(record)
        start += size
    return result


def summarize(data: bytes) -> dict:
    if data[:4] != b'  CP':
        raise ValueError('Not a little-endian PC model')
    roots = chunks(data, 4, len(data))
    if not roots or roots[0]['id'] != 'Model' or roots[0]['type'] != 0x43:
        raise ValueError('Expected Model container')
    result = {'chunks': roots, 'render': None}
    outer = next((c for c in roots[0].get('children', []) if c['id'] == 'Render'), None)
    if outer is None:
        return result
    # C_RenderModel::Read constructs a new C_FileBlock inside this data payload.
    inner = chunks(data, outer['offset'] + 16, outer['offset'] + outer['bytes'])
    if len(inner) != 1 or inner[0]['id'] != 'Render' or inner[0]['type'] != 0x43:
        raise ValueError('Expected exact inner Render container')
    scene = next((c for c in inner[0]['children'] if c['id'] == 'Scene'), None)
    info = {'outerOffset': outer['offset'], 'bytes': outer['bytes'], 'inner': inner[0]}
    if scene:
        origin = scene['offset'] + 16
        end = scene['offset'] + scene['bytes']
        if origin + 28 > end or data[origin:origin + 4] != b'ARCH' or data[origin + 12:origin + 16] != b'ARCH':
            raise ValueError('Scene archive envelope mismatch')
        outer_version, swap = struct.unpack_from('<II', data, origin + 4)
        inner_version, world_version = struct.unpack_from('<II', data, origin + 16)
        if outer_version != 1 or swap != 0:
            raise ValueError('Non-PC/endian archive not supported')
        marker, scene_version = struct.unpack_from('<2sH', data, origin + 24)
        if marker != b'RA':
            raise ValueError('Target Scene class marker mismatch')
        info['archive'] = {'origin': origin, 'outerVersion': outer_version, 'endianSwap': swap,
                           'innerVersion': inner_version, 'worldReadSceneVersion': world_version,
                           'targetSceneClassVersion': scene_version,
                           'prefix32Hex': data[origin:origin + 32].hex()}
    result['render'] = info
    return result


def diverse_selection(rows: list[dict], limit: int) -> list[dict]:
    ordered = sorted(rows, key=lambda r: (r['logical_bytes'], r['path']))
    selected = [r for r in ordered if r['path'] == TRAFFIC][:1]
    # Keep small simple candidates, then sample parent directories in round-robin
    # order. Filenames, not bytes interpreted as object ids, define diversity.
    for row in ordered[:min(8, limit)]:
        if row not in selected and len(selected) < limit:
            selected.append(row)
    groups = defaultdict(deque)
    for row in ordered:
        if row not in selected:
            groups[row['path'].rsplit('\\', 1)[0]].append(row)
    while len(selected) < limit and groups:
        for key in sorted(list(groups)):
            selected.append(groups[key].popleft())
            if not groups[key]:
                del groups[key]
            if len(selected) == limit:
                break
    return selected


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--game-dir', type=Path, default=Path('game-data/Blur'))
    parser.add_argument('--out-dir', type=Path, default=Path('_work/model-corpus'))
    parser.add_argument('--limit', type=int, default=30)
    args = parser.parse_args()
    if not 1 <= args.limit <= 30:
        parser.error('limit must be 1..30')
    game = args.game_dir.resolve(strict=True)
    output = args.out_dir.resolve()
    if output.is_relative_to(game):
        parser.error('Corpus output must be outside game data')
    source = game / 'cache/root.pak'
    index = pak_index(source)
    if index.get('codec') != 4 or index.get('fat_type') != 0:
        raise ValueError('Expected normal-FAT packet-zlib root.pak')
    eligible = [r for r in index['entries'] if not r['directory'] and r['path'].endswith('.model')
                and 20 <= r['logical_bytes'] <= MAX_BYTES and 8 <= r['stored_bytes'] <= MAX_BYTES + 8]
    selected = diverse_selection(eligible, args.limit)
    output.mkdir(parents=True, exist_ok=True)
    records, rejected = [], []
    with source.open('rb') as stream:
        for number, entry in enumerate(selected):
            try:
                stream.seek(entry['offset'])
                packed = stream.read(entry['stored_bytes'])
                if len(packed) != entry['stored_bytes']:
                    raise ValueError('Short source read')
                data = decode_packet(packed, entry['logical_bytes'])
                summary = summarize(data)
                digest = hashlib.sha256(data).hexdigest()
                stem = entry['path'].rsplit('\\', 1)[-1].removesuffix('.model')
                filename = f'{number:02d}-{stem}-{digest[:8]}.model'
                (output / filename).write_bytes(data)
                records.append({'file': filename, 'sourceEntry': entry, 'decodedBytes': len(data),
                                'decodedSha256': digest, **summary})
            except (ValueError, UnicodeError, struct.error, zlib.error) as error:
                rejected.append({'path': entry['path'], 'reason': str(error)})
    report = {'sourcePak': str(source), 'scope': 'Local fixtures, <=64KiB single-packet PC models. No authenticity claim.',
              'eligibleCount': len(eligible), 'requestedCount': len(selected),
              'preparedCount': len(records), 'models': records, 'rejected': rejected}
    (output / 'manifest.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(f'Prepared {len(records)}/{len(selected)} selected models ({len(eligible)} eligible); {len(rejected)} rejected')
    for row in sorted(records, key=lambda r: (r['render']['bytes'] if r['render'] else 0, r['file'])):
        print(f"{row['file']}: {row['decodedBytes']} bytes; Render {row['render']['bytes'] if row['render'] else 'none'}")


if __name__ == '__main__':
    main()
