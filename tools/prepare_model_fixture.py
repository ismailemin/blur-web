"""Prepare a small local comparison fixture with the independent Python reader."""
import argparse
import hashlib
import json
import struct
import zlib
from pathlib import Path

from inspect_asset_layout import pak_index


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--game-dir', type=Path, default=Path('game-data/Blur'))
    parser.add_argument('--out-dir', type=Path, default=Path('_work/model-probe'))
    args = parser.parse_args()
    root = args.game_dir.resolve(strict=True)
    output = args.out_dir.resolve()
    if output.is_relative_to(root):
        parser.error('Fixture output must be outside game data')
    source = root / 'cache/root.pak'
    index = pak_index(source)
    target = '\\models\\objects\\usa_la_river\\misc\\trafficcylinder.model'
    entry = next(row for row in index['entries'] if row['path'] == target)
    if index['codec'] != 4 or index['fat_type'] != 0 or not 1 <= entry['logical_bytes'] <= 65536 or not 8 <= entry['stored_bytes'] <= 65544:
        raise ValueError('Unsupported fixture shape')
    with source.open('rb') as stream:
        stream.seek(entry['offset'])
        packed = stream.read(entry['stored_bytes'])
    packet_size, compressed_size = struct.unpack_from('<II', packed)
    if packet_size != 65536 or compressed_size + 8 != len(packed):
        raise ValueError('Unsupported fixture packet')
    inflater = zlib.decompressobj(-15)
    decoded = inflater.decompress(packed[8:], entry['logical_bytes'] + 1)
    if len(decoded) != entry['logical_bytes'] or not inflater.eof or inflater.unused_data or inflater.unconsumed_tail:
        raise ValueError('Invalid fixture stream')
    output.mkdir(parents=True, exist_ok=True)
    (output / 'trafficcylinder.model').write_bytes(decoded)
    identity = {'pak': str(source), 'entry': entry, 'decoded_sha256': hashlib.sha256(decoded).hexdigest(), 'note': 'Local comparison fixture; not an authenticity check'}
    (output / 'trafficcylinder.source.json').write_text(json.dumps(identity, indent=2) + '\n', encoding='utf-8')
    print(f'Prepared {len(decoded)} bytes, SHA-256 {identity["decoded_sha256"]}')


if __name__ == '__main__':
    main()
