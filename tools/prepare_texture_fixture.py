"""Read one bounded PC .texture payload from root.pak; retain local test bytes only."""
from __future__ import annotations
import argparse
import hashlib
import io
import json
import struct
import zlib
from pathlib import Path
from inspect_asset_layout import pak_index

ROOT = Path(__file__).resolve().parent.parent


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--path', default=r'\graphics\textures\specialfx\arrow.texture')
    parser.add_argument('--pak', choices=['root.pak', 'boot.pak'], default='root.pak')
    parser.add_argument('--output-name', default='arrow')
    args = parser.parse_args()
    if not args.output_name.replace('-', '').replace('_', '').isalnum():
        parser.error('Output name must be a single identifier')
    pak = ROOT / 'game-data/Blur/cache' / args.pak
    index = pak_index(pak)
    if index['codec'] != 4 or index['fat_type'] != 0:
        raise ValueError('Only regular packet-zlib PAK supported by this fixture tool')
    row = next(r for r in index['entries'] if r['path'].lower() == args.path.lower())
    if not row['path'].endswith('.texture') or not 84 <= row['logical_bytes'] <= 65536 or not 8 <= row['stored_bytes'] <= 65544:
        raise ValueError('Texture exceeds one-packet fixture bounds')
    with pak.open('rb') as stream:
        stream.seek(row['offset'])
        packed = stream.read(row['stored_bytes'])
    packet, size = struct.unpack_from('<II', packed)
    if packet != 65536:
        raise ValueError('Unsupported packet size')
    if size == 0xffffffff:
        if len(packed) != 65544:
            raise ValueError('Truncated raw packet')
        decoded = packed[8:8 + row['logical_bytes']]
    else:
        if size + 8 != len(packed):
            raise ValueError('Compressed packet size mismatch')
        inflater = zlib.decompressobj(-15)
        decoded = inflater.decompress(packed[8:], row['logical_bytes'] + 1)
        if not inflater.eof or inflater.unused_data or inflater.unconsumed_tail:
            raise ValueError('Malformed or oversized deflate stream')
    if len(decoded) != row['logical_bytes'] or decoded[:8] != b'Texture\0':
        raise ValueError('Invalid decoded texture')
    # Source-defined container/descriptor offsets, not magic scanning.
    if struct.unpack_from('<I', decoded, 8)[0] != len(decoded) or decoded[16:24] != b'Header\0\0' or decoded[40:48] != b'Data\0\0\0\0':
        raise ValueError('Unsupported texture layout')
    width, height, depth, levels, fmt, usage, kind = struct.unpack_from('<7I', decoded, 56)
    if width > 512 or height > 512 or not width or not height or depth != 1 or kind != 3:
        raise ValueError('Texture dimensions/type outside preview scope')
    metadata = {'pak': args.pak, **row, 'sha256': hashlib.sha256(decoded).hexdigest(),
                'width': width, 'height': height, 'format': fmt, 'levels': levels}
    output = ROOT / '_work/texture-probe'
    output.mkdir(parents=True, exist_ok=True)
    (output / f'{args.output_name}.texture').write_bytes(decoded)
    # Independent Pillow DDS decoder: same PC TextureDesc/texel bytes, standard DDS wrapper.
    if fmt in [int.from_bytes(b'DXT1', 'little'), int.from_bytes(b'DXT3', 'little'), int.from_bytes(b'DXT5', 'little')]:
        from PIL import Image
        header = [124, 0x1007, height, width, 0, 0, 1] + [0] * 11
        header += [32, 4, fmt, 0, 0, 0, 0, 0, 0x1000, 0, 0, 0, 0]
        dds = b'DDS ' + struct.pack('<31I', *header) + decoded[84:]
        image = Image.open(io.BytesIO(dds)).convert('RGBA')
        pixels = image.tobytes()
        (output / f'{args.output_name}.rgba').write_bytes(pixels)
        image.save(output / f'{args.output_name}.png')
        metadata['independentPillowRgbaSha256'] = hashlib.sha256(pixels).hexdigest()
        metadata['independentPillowVersion'] = __import__('PIL').__version__
    (output / f'{args.output_name}.source.json').write_text(json.dumps(metadata, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(metadata, indent=2))


if __name__ == '__main__':
    main()
