"""Prepare local PC XT fixtures and independent source-shaped metadata evidence.

Reads only the existing game PAKs. Outputs remain under the requested work folder;
no original game file is changed and no executable is run.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import struct
import zlib
from pathlib import Path
from inspect_asset_layout import pak_index

MAX_BYTES = 64 * 1024 * 1024
TABLES = [('types', 12, 4096), ('bases', 4, 65535), ('fields', 8, 100000),
          ('strings', 1, 4 * 1024 * 1024), ('refs', 8, 65535),
          ('records', 16, 65535), ('components', 6, 100000), ('data', 1, MAX_BYTES)]


def inspect(data: bytes) -> dict:
    if not 72 <= len(data) <= MAX_BYTES:
        raise ValueError('XT input outside bounds')
    header = struct.unpack_from('<18I', data)
    if header[0] != 0x464C534B or header[1] not in (1, 2):
        raise ValueError('Unsupported PC FLSK tag/version')
    tables = {}
    regions = []
    for i, (name, size, limit) in enumerate(TABLES):
        offset, count = header[2 + i * 2:4 + i * 2]
        length = count * size
        if offset % 4 or count > limit or offset > len(data) or length > len(data) - offset:
            raise ValueError(f'{name} table outside bounds')
        if length:
            if offset < 72:
                raise ValueError('Table overlaps header')
            regions.append((offset, offset + length))
        tables[name] = {'offset': offset, 'count': count, 'elementBytes': size}
    regions.sort()
    if any(a[1] > b[0] for a, b in zip(regions, regions[1:])):
        raise ValueError('Overlapping XT tables')
    def rows(name, fmt):
        t = tables[name]
        return [struct.unpack_from('<' + fmt, data, t['offset'] + i * t['elementBytes']) for i in range(t['count'])]
    st = tables['strings']
    encoded = data[st['offset']:st['offset'] + st['count']]
    strings = bytearray(encoded)
    if header[1] == 2 and strings:
        previous = 0xCC
        for i, byte in enumerate(encoded[:-1]):
            decoded = (previous - (byte ^ 0xB3)) & 255
            strings[i] = decoded
            previous = (previous + decoded - i) & 255
        strings[-1] = 0
    def name(at):
        if at >= len(strings):
            raise ValueError('Schema name outside string table')
        end = strings.find(0, at)
        if end < at or end - at > 4096:
            raise ValueError('Unterminated/oversize schema name')
        value = strings[at:end]
        if any(x < 32 or x > 126 for x in value):
            raise ValueError('Unsupported schema name encoding')
        return value.decode('ascii')
    types = rows('types', '6H')
    bases = rows('bases', '2H')
    fields = rows('fields', '3H2B')
    refs = rows('refs', 'I2H')
    records = rows('records', '4I')
    components = rows('components', '3H')
    base_at = field_at = 0
    type_output, field_output = [], []
    for i, (nm, nf, nb, behaviour, atom, size) in enumerate(types):
        if behaviour >= 4 or (behaviour == 0 and not 0 < atom < 15) or (behaviour != 0 and atom != 0):
            raise ValueError('Invalid XT type behaviour/atom')
        if (behaviour == 0 and nf) or (behaviour != 3 and nb):
            raise ValueError('Invalid XT atom/base count')
        if nb > len(bases) - base_at or nf > len(fields) - field_at:
            raise ValueError('Type schema range outside table')
        for bt, offset in bases[base_at:base_at + nb]:
            if bt >= len(types) or types[bt][3] != 3 or offset > size or types[bt][5] > size - offset:
                raise ValueError('Invalid XT base reference/range')
        for fi in range(field_at, field_at + nf):
            fn, ft, off, fb, arr = fields[fi]
            if fb >= 7:
                raise ValueError('Invalid XT field behaviour')
            if behaviour in (1, 2):
                if ft != 65535 or off or fb != 6 or arr:
                    raise ValueError('Invalid XT enum/flag label')
            elif behaviour == 3:
                if ft >= len(types) or fb >= 6:
                    raise ValueError('Invalid XT struct field type')
                expected = [0, 1, 2, 3, 3, 3][fb]
                if types[ft][3] != expected:
                    raise ValueError('Mismatched XT field/type behaviour')
                width = 8 if arr else 4 if fb in (4, 5) else types[ft][5]
                if off > size or width > size - off:
                    raise ValueError('XT field exceeds containing type')
            field_output.append({'index': fi, 'name': name(fn), 'typeIndex': None if ft == 65535 else ft,
                                 'offset': off, 'behaviour': fb, 'array': bool(arr)})
        type_output.append({'index': i, 'name': name(nm), 'behaviour': behaviour, 'atom': atom,
                            'size': size, 'baseStart': base_at, 'baseCount': nb,
                            'fieldStart': field_at, 'fieldCount': nf})
        base_at += nb
        field_at += nf
    if base_at != len(bases) or field_at != len(fields):
        raise ValueError('Unused XT schema table rows')
    last_id = 0
    for ident, typ, record in refs:
        if ident <= last_id or typ >= len(types) or (record != 65535 and record >= len(records)):
            raise ValueError('Invalid XT ref ordering/type/record')
        last_id = ident
    component_at = data_at = 0
    record_output = []
    for i, (ref, nc, nd, ns) in enumerate(records):
        if ref >= len(refs) or nc == 0 or nc > len(components) - component_at:
            raise ValueError('Invalid XT record/component range')
        used = 0
        for typ, count, behaviour in components[component_at:component_at + nc]:
            if typ >= len(types) or behaviour >= 3:
                raise ValueError('Invalid XT component type/behaviour')
            used = (used + count * (types[typ][5] if behaviour == 0 else 4) + 3) & ~3
        if used != nd or nd + ns > tables['data']['count'] - data_at:
            raise ValueError('XT record data extent mismatch')
        record_output.append({'index': i, 'id': refs[ref][0], 'typeIndex': refs[ref][1],
                              'componentStart': component_at, 'componentCount': nc,
                              'dataOffset': tables['data']['offset'] + data_at,
                              'dataBytes': nd, 'stringBytes': ns})
        component_at += nc
        data_at += nd + ns
    if component_at != len(components) or data_at != tables['data']['count']:
        raise ValueError('Unused XT component/data bytes')
    return {'status': 'ok', 'format': 'FLSK', 'version': header[1], 'endian': 'little',
            'inputBytes': len(data), 'schemaBoundsValidated': True, 'recordPayloadValidated': False,
            'runtimeObjectsCreated': False, 'integrityValidated': False,
            'tables': tables, 'types': type_output, 'fields': field_output, 'records': record_output}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--game-dir', type=Path, default=Path('game-data/Blur'))
    parser.add_argument('--out-dir', type=Path, default=Path('_work/xt-probe'))
    args = parser.parse_args()
    game = args.game_dir.resolve(strict=True)
    output = args.out_dir.resolve()
    if output.is_relative_to(game):
        parser.error('XT fixture output must be outside game data')
    pak = game / 'cache/gamedata.pak'
    index = pak_index(pak)
    if index.get('codec') != 2 or index.get('fat_type') not in (0, 1):
        raise ValueError('Expected known-FAT zlib game data PAK')
    output.mkdir(parents=True, exist_ok=True)
    manifest = []
    for scene in ['vehicletestscene', 'showroom', 'global']:
        entry = next(r for r in index['entries'] if r['path'] == f'\\gamedata\\levels\\{scene}\\actorpack.xt')
        if not 72 <= entry['logical_bytes'] <= 65536 or not 1 <= entry['stored_bytes'] <= 65536:
            raise ValueError('XT fixture exceeds bounded extraction scope')
        with pak.open('rb') as stream:
            stream.seek(entry['offset'])
            packed = stream.read(entry['stored_bytes'])
        if len(packed) != entry['stored_bytes']:
            raise ValueError('Short PAK read')
        inflater = zlib.decompressobj()
        decoded = inflater.decompress(packed, entry['logical_bytes'] + 1)
        if len(decoded) != entry['logical_bytes'] or not inflater.eof or inflater.unused_data or inflater.unconsumed_tail:
            raise ValueError('XT zlib stream extent mismatch')
        report = inspect(decoded)
        path = output / f'{scene}.xt'
        path.write_bytes(decoded)
        (output / f'{scene}.reference.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
        manifest.append({'file': path.name, 'pak': 'gamedata.pak', 'entry': entry,
                         'sha256': hashlib.sha256(decoded).hexdigest(), 'decodedBytes': len(decoded),
                         'types': len(report['types']), 'fields': len(report['fields']), 'records': len(report['records'])})
    (output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(manifest, indent=2))


if __name__ == '__main__':
    main()

