"""Copy the committed scene_reader.cpp into probes/lights/tools/ and add a
four-component UV0 export (uv0xyzw).

The committed reader exports only UV0.xy even when the declaration is F16_4 /
F32_4. Light materials sample OffTexture at UV0.xy and OnTexture at UV0.zw, so
the same reader is retained and one parallel array is added:

  * std::vector<float> uvs4
  * four components stored for every vertex (zw = 0 for a two-component UV)
  * "uv0xyzw":[...] next to "uv0":[...]

Every other line is unchanged. The committed source is read-only input.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SRC = ROOT / 'probes/asset-reader/src/scene_reader.cpp'
DST = ROOT / 'probes/lights/tools/scene_reader_uv4.cpp'

text = SRC.read_text(encoding='utf-8')
original = text


def replace_once(old, new):
    global text
    assert text.count(old) == 1, f'{text.count(old)} occurrences of {old!r}'
    text = text.replace(old, new)


# 1. declare the parallel four-component array next to the committed uv array.
replace_once('std::vector<float> positions,uvs;std::vector<uint32_t> triangles;',
             'std::vector<float> positions,uvs;std::vector<float> uvs4;'
             'std::vector<uint32_t> triangles;')

# 2. store four components per vertex, keeping uvs (xy only) for the committed hash.
replace_once(
    'if(has_uv){r.p=vb.data+size_t(v)*vb.stride+uv->offset;'
    'for(int a=0;a<2;a++)uvs.push_back(uv->type==5?r.f32():half(r.u16()));}'
    'else{uvs.push_back(0);uvs.push_back(0);}',
    '{float comp[4]={0,0,0,0};'
    'if(has_uv){r.p=vb.data+size_t(v)*vb.stride+uv->offset;'
    'const int ncomp=(uv->type==8)?2:4;'
    'for(int a=0;a<ncomp;a++)comp[a]=(uv->type==5?r.f32():half(r.u16()));}'
    'uvs.push_back(comp[0]);uvs.push_back(comp[1]);'
    'for(int a=0;a<4;a++)uvs4.push_back(comp[a]);}')

# 3. export the four-component stream next to the two-component stream.
replace_once(
    'out<<"],\\"uv0\\":[";for(size_t i=0;i<uvs.size();i++){if(i)out<<\',\';out<<uvs[i];}'
    'out<<"],\\"sharedTextures\\":[',
    'out<<"],\\"uv0\\":[";for(size_t i=0;i<uvs.size();i++){if(i)out<<\',\';out<<uvs[i];}'
    'out<<"],\\"uv0xyzw\\":[";for(size_t i=0;i<uvs4.size();i++){if(i)out<<\',\';out<<uvs4[i];}'
    'out<<"],\\"sharedTextures\\":[')

# 4. mark the added field in the metadata block.
replace_once('\\"uv0PlaceholderPolicy\\":\\"zero pairs; unavailable draws cannot bind albedo\\",',
             '\\"uv0PlaceholderPolicy\\":\\"zero pairs; unavailable draws cannot bind albedo\\",'
             '\\"uv0xyzwExported\\":true,\\"uv0xyzwComponents\\":4,'
             '\\"uv0xyzwNote\\":\\"four-component UV0 for light materials: xy=OffTexture, zw=OnTexture\\",')

assert text != original
DST.write_text(text, encoding='utf-8')
print('wrote', DST, len(text))
