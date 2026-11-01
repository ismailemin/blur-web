"""Extract one explicitly selected normal-FAT packet-zlib asset for local comparisons."""
from __future__ import annotations
import argparse
import hashlib
import json
import struct
import zlib
from pathlib import Path
from inspect_asset_layout import pak_index

ROOT=Path(__file__).resolve().parent.parent
LIMIT=16*1024*1024
PACKET=65536
PACKAGES={'root.pak','boot.pak','gamedata.pak','gamedata_boot.pak','lut_rampak.pak','root_streaming.pak'}

def decode_packet_zlib(data: bytes,logical: int)->bytes:
    if not 1<=logical<=LIMIT or len(data)<8:
        raise ValueError('Asset outside bounded decoder scope')
    if struct.unpack_from('<I',data)[0]!=PACKET:
        raise ValueError('Unsupported packet size')
    cursor=4
    output=bytearray()
    count=0
    max_packets=(logical+PACKET-1)//PACKET+1
    if len(data)>4+max_packets*(PACKET+4):
        raise ValueError('Packed asset outside limit')
    while cursor<len(data):
        count+=1
        if count>max_packets or cursor+4>len(data):
            raise ValueError('Invalid packet header/count')
        stored=struct.unpack_from('<I',data,cursor)[0]
        cursor+=4
        raw=stored==0xffffffff
        size=PACKET if raw else stored
        if not 1<=size<=PACKET or cursor+size>len(data):
            raise ValueError('Invalid packet payload bounds')
        expected=min(PACKET,logical-len(output))
        if not expected and (raw or cursor+size!=len(data) or logical%PACKET):
            raise ValueError('Unexpected final packet')
        payload=data[cursor:cursor+size]
        cursor+=size
        if raw:
            output.extend(payload[:expected])
        else:
            inflater=zlib.decompressobj(-15)
            decoded=inflater.decompress(payload,expected+1)
            if len(decoded)!=expected or not inflater.eof or inflater.unused_data or inflater.unconsumed_tail:
                raise ValueError('Invalid DEFLATE stream or decoded packet length')
            output.extend(decoded)
    if len(output)!=logical:
        raise ValueError('Decoded asset length mismatch')
    return bytes(output)

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pak',choices=sorted(PACKAGES),default='root.pak')
    parser.add_argument('--path',required=True,help='Exact in-PAK asset path')
    parser.add_argument('--out-dir',type=Path,default=ROOT/'_work/asset-fixtures')
    args=parser.parse_args()
    game=(ROOT/'game-data/Blur').resolve(strict=True)
    output=args.out_dir.resolve()
    if output.is_relative_to(game):
        parser.error('Output must be outside game data')
    package=game/'cache'/args.pak
    index=pak_index(package)
    if index['codec']!=4 or index['fat_type']!=0:
        parser.error('Only normal-FAT packet-zlib supported')
    entry=next((entry for entry in index['entries'] if entry['path'].lower()==args.path.lower()),None)
    if not entry or not 1<=entry['logical_bytes']<=LIMIT or not 8<=entry['stored_bytes']<=LIMIT+131072:
        parser.error('Missing asset or size outside scope')
    with package.open('rb') as stream:
        stream.seek(entry['offset'])
        packed=stream.read(entry['stored_bytes'])
    decoded=decode_packet_zlib(packed,entry['logical_bytes'])
    digest=hashlib.sha256(decoded).hexdigest()
    output.mkdir(parents=True,exist_ok=True)
    target=output/(digest+'.decoded')
    target.write_bytes(decoded)
    info={'pak':args.pak,**entry,'sha256':digest,'decodedFile':str(target),'packetCount':(len(decoded)+PACKET-1)//PACKET}
    target.with_suffix('.source.json').write_text(json.dumps(info,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(info))

if __name__=='__main__':
    main()
