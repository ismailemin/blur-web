#include "scene_reader.h"
#if defined(__EMSCRIPTEN__)
#include <emscripten.h>
#else
#define EMSCRIPTEN_KEEPALIVE
#endif
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <iomanip>
#include <limits>
#include <locale>
#include <map>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
constexpr size_t max_input=64*1024*1024;
constexpr size_t level_input_limit=16u*1024u*1024u;
constexpr uint32_t max_count=100000;
std::string escape(const char* text);
std::string hex16(uint64_t value);
uint64_t uv_range_hash(const std::vector<float>& uv,const std::vector<uint32_t>& indices,uint32_t first,uint32_t count);
struct Reader {
    const unsigned char* b;size_t end,p=0,origin=0;uint32_t objects=0;
    [[noreturn]] void fail(const std::string& message) const {throw std::runtime_error(message+" at byte "+std::to_string(p));}
    void need(size_t n)const{if(p>end||n>end-p)fail("Truncated scene");}
    void skip(size_t n){need(n);p+=n;}
    uint8_t u8(){need(1);return b[p++];}
    uint16_t u16(){need(2);uint16_t v=static_cast<uint16_t>(uint16_t(b[p])|uint16_t(b[p+1])<<8);p+=2;return v;}
    uint32_t u32(){need(4);uint32_t v=uint32_t(b[p])|uint32_t(b[p+1])<<8|uint32_t(b[p+2])<<16|uint32_t(b[p+3])<<24;p+=4;return v;}
    uint64_t u64(){const uint64_t lo=u32(),hi=u32();return lo|(hi<<32);}
    int32_t s32(){return static_cast<int32_t>(u32());}
    float f32(){auto bits=u32();float f;std::memcpy(&f,&bits,4);if(!std::isfinite(f))fail("Nonfinite position");return f;}
    float f32_bits(){auto bits=u32();float f;std::memcpy(&f,&bits,4);return f;}
    void expect(uint32_t value){if(u32()!=value)fail("Unsupported serialized value");}
    uint16_t ar(uint16_t max_version=0){if(++objects>max_count)fail("Archive object limit");if(u16()!=0x4152)fail("Missing RA object marker");auto v=u16();if(v>max_version)fail("Unsupported object version");return v;}
    uint32_t count(uint32_t limit=max_count){auto n=u32();if(n>limit)fail("Collection limit");return n;}
    uint32_t vec(uint32_t limit=max_count){ar();return count(limit);}
    std::string str(){auto n=count(4096);need(n);std::string s(reinterpret_cast<const char*>(b+p),n);p+=n;return s;}
    void literal(const char* value,size_t n){need(n);if(std::memcmp(b+p,value,n))fail("Unsupported archive signature");p+=n;}
    // Btl::BitVector is Vector<U8>; BitVector32 is a separate source type.
    // Reserve() may retain more bytes than SetNumBits() requires.
    void bitvector(){ar();auto bits=count(8*1024*1024);auto bytes=vec();if(bytes<(bits+7)/8)fail("Invalid bit vector byte count");skip(bytes);}
    void bounds(){ar();skip(32);}
    void node(){ar();str();auto n=vec();skip(size_t(n)*8);skip(16);}
    void cull(){auto v=ar(2);node();bounds();bitvector();if(v>0)skip(4);if(v>1)bitvector();}
    void root(){ar();cull();}
    bool pointer(){auto tag=u8();if(tag==0)return false;if(tag!=2)fail("Unsupported non-polymorphic pointer tag");return true;}
    size_t blob(size_t expected){ar();auto n=u32(),alignment=u32(),compression=u32();auto swap=u8();if(n!=expected)fail("Buffer byte size mismatch");if(!alignment||alignment>4096||(alignment&(alignment-1)))fail("Invalid buffer alignment");if(compression||swap)fail("Unsupported compressed/endian buffer");if(p<origin)fail("Invalid stream origin");skip((alignment-(p-origin)%alignment)%alignment);size_t start=p;skip(n);return start;}
};

struct Chunk {size_t start,end,payload;uint16_t count;uint8_t type;std::string id;};
Chunk chunk(Reader& r,size_t start,size_t parent_end){
    r.p=start;r.need(16);size_t n=0;while(n<8&&r.b[start+n])++n;
    std::string id(reinterpret_cast<const char*>(r.b+start),n);
    for(size_t i=n;i<8;i++)if(r.b[start+i])r.fail("Invalid chunk ID padding");
    r.p=start+8;auto size=r.u32();auto count=r.u16();auto type=r.u8();auto compression=r.u8();
    if(size<16||start>parent_end||size>parent_end-start||compression)r.fail("Unsupported chunk bounds/compression");
    if(type!=0x41&&type!=0x43)r.fail("Unsupported chunk type");
    return {start,start+size,start+16,count,type,id};
}
Chunk child(Reader& r,const Chunk& parent,const char* id){
    if(parent.type!=0x43)r.fail("Expected container");
    size_t at=parent.payload;Chunk found{};bool present=false;
    if(parent.count>10000)r.fail("Chunk count limit");
    for(uint16_t i=0;i<parent.count;i++){auto c=chunk(r,at,parent.end);at=c.end;if(c.id==id){if(present)r.fail("Duplicate named chunk");found=c;present=true;}}
    if(at!=parent.end)r.fail("Container child size mismatch");if(!present)r.fail(std::string("Missing ")+id+" chunk");return found;
}
struct Element{int32_t type,method,usage,index;uint16_t offset;};
struct DeclarationElement{int32_t stream;Element value;};
struct VB{uint32_t stride,count;size_t data;std::vector<Element> elements;};
struct IB{uint32_t count,width;size_t data;};
struct Lod{uint32_t offset,count,min,vertices;};
struct Stream{int32_t vb,index,offset,frequency,material,material_list;};
struct MaterialRef{int32_t index=0,list=0;};
struct Primitive{int32_t effect,declaration,topology,ib;MaterialRef base,instance;bool has_instance=false;std::vector<Lod> lods;std::vector<Stream> streams;};
struct MaterialField {std::string name;int32_t type;uint32_t count;};
struct MaterialType{std::string name;std::vector<MaterialField> fields;};
enum class MaterialActionKind {Texture,Runtime,Nested};
struct MaterialAction{MaterialActionKind kind;std::string name;int32_t value,list=0;};
struct MaterialRow {std::string type_name;std::vector<MaterialAction> actions;};
struct AlbedoState{bool seen=false,known=false;int32_t value=-1,row=-1;std::string reason;};
struct MaterialState{AlbedoState prop,vehicle;};
struct Resource {int32_t block,index;};
struct Draw {uint32_t first,count;int32_t albedo=-1;std::string binding;bool uv_available=false;std::string albedo_parameter;int32_t resource_block=-1,resource_index=-1;int32_t material_row=-1;std::string material;uint64_t uv_hash=0;bool uv_hashed=false;std::string binding_status;std::string binding_reason;};
// Direct-draw and instance exports share this field set. Identity resolution is
// reported as-is; blocked draws keep an explicit reason and no invented texture.
void write_draw_json(std::ostringstream& out,const Draw& d){
    out<<"{\"firstIndex\":"<<d.first<<",\"indexCount\":"<<d.count<<",\"albedoTexture\":";
    if(d.albedo<0)out<<"null";else out<<d.albedo;
    out<<",\"binding\":\""<<escape(d.binding.c_str())<<"\",\"uv0Available\":"<<(d.uv_available?"true":"false")<<",\"albedoParameter\":";
    if(d.albedo_parameter.empty())out<<"null";else out<<'"'<<escape(d.albedo_parameter.c_str())<<'"';
    out<<",\"resourceBlock\":";if(d.resource_block<0)out<<"null";else out<<d.resource_block;
    out<<",\"resourceIndex\":";if(d.resource_index<0)out<<"null";else out<<d.resource_index;
    out<<",\"material\":";if(d.material.empty())out<<"null";else out<<'"'<<escape(d.material.c_str())<<'"';
    out<<",\"materialRow\":"<<d.material_row<<",\"uvHash\":";
    if(d.uv_hashed)out<<'"'<<"0x"<<hex16(d.uv_hash)<<'"';else out<<"null";
    out<<",\"bindingStatus\":\""<<d.binding_status<<"\",\"bindingReason\":";
    if(d.binding_reason.empty())out<<"null";else out<<'"'<<escape(d.binding_reason.c_str())<<'"';
    out<<'}';
}
struct Texture {std::string name;uint32_t hash;size_t offset,bytes;};
struct TextureLodInfo {
    int32_t lod=-1;bool present=false;uint16_t version=0;size_t archive_offset=0;
    size_t descriptor_offset=0;uint32_t descriptor_bytes=0;
    uint32_t width=0,height=0,depth=0,levels=0,format=0,usage=0,type=0;
    size_t payload_offset=0;uint32_t payload_bytes=0;
    int32_t paired_block=-1,paired_index=-1;
    uint64_t complete_mip_bytes=0;uint32_t top_mip_levels=0;
    bool supported=false;std::string reason;
};
struct ResourceTextureInfo {
    int32_t index=-1;std::string name;uint32_t hash=0;
    uint16_t sampler_version=0;std::vector<uint32_t> sampler;
    std::vector<TextureLodInfo> lods;
};
struct ResourceBlockInfo {int32_t index=-1;uint32_t lod_count=0;std::vector<ResourceTextureInfo> textures;};
struct InstanceInfo {int32_t primitive_index=0;MaterialRef material;std::vector<Stream> streams;uint32_t flags=0;};
struct TransformField {std::string name;int32_t type=0;uint32_t count=0;std::vector<float> floats;std::vector<MaterialRef> nested;bool runtime=false;};
struct TransformRow {int32_t type_index=-1;std::string type_name;std::vector<TransformField> fields;};
struct RenderListInfo {
    std::vector<Primitive> primitives,base_primitives;
    std::vector<InstanceInfo> instances;
    std::vector<TransformRow> constants;
    std::vector<MaterialRow> material_rows;
    std::vector<Resource> index_sources,vertex_sources,texture_sources;
    std::vector<std::array<float,8>> instance_bounds;
};
struct ChunkItem {int32_t block,lod;};
struct StreamChunk {std::vector<ChunkItem> items;std::vector<int32_t> prerequisites;uint64_t offset,stored,original;};
float half(uint16_t h){const int sign=(h&0x8000)?-1:1;auto exp=(h>>10)&31,frac=h&1023;if(exp==31)throw std::runtime_error("Nonfinite half value");return sign*(exp?std::ldexp(float(1024+frac),int(exp)-25):std::ldexp(float(frac),-24));}
// DXT1/DXT3/DXT5 as stored in the PC TextureDesc. Other formats return 0 and
// are left to the standalone texture decoder's own format checks.
uint64_t mip_level_bytes(uint32_t format,uint32_t width,uint32_t height,uint32_t level){
    const uint64_t block=format==0x31545844u?8u:(format==0x33545844u||format==0x35545844u)?16u:0u;
    if(!block)return 0;
    const uint64_t w=std::max(1u,width>>level),h=std::max(1u,height>>level);
    return ((w+3)/4)*((h+3)/4)*block;
}
uint64_t complete_mip_bytes(uint32_t format,uint32_t width,uint32_t height,uint32_t levels){
    const uint64_t block=format==0x31545844u?8u:(format==0x33545844u||format==0x35545844u)?16u:0u;
    if(!block||!levels)return 0;
    uint64_t total=0;
    for(uint32_t level=0;level<levels;level++)total+=mip_level_bytes(format,width,height,level);
    return total;
}
struct Decoder {
    Reader r;std::vector<VB> vbs;std::vector<IB> ibs;std::vector<Primitive> primitives;
    uint32_t declarations=0,block=0,node_index=0;std::string scene_name,node_name;
    std::vector<std::string> effect_names;
    std::vector<std::vector<DeclarationElement>> declaration_elements;
    std::vector<float> positions,uvs;std::vector<uint32_t> triangles;std::vector<Texture> textures;std::vector<Draw> draws;
    std::vector<MaterialRow> constants;std::vector<Resource> texture_sources,vertex_sources,index_sources;std::string binding_error="Render-list material tail not parsed";bool binding_tail=false;
    int32_t expected_resource_block=0;
    uint32_t resource_blocks=0,loaded_blocks=0,instance_count=0,instance_batch_count=0,base_primitive_count=0;
    std::vector<StreamChunk> stream_chunks;
    std::vector<RenderListInfo> render_lists;
    uint32_t valid_uv_vertices=0,placeholder_uv_vertices=0,material_steps=0;
    MaterialType material_type(){
        r.ar();auto name=r.str();auto n=r.vec(4096);MaterialType t;t.name=name;
        for(uint32_t i=0;i<n;i++){r.ar();auto name=r.str();auto type=r.s32();auto count=r.count(4096);if(type<0||type>10)r.fail("Unsupported material element type");t.fields.push_back({name,type,count});}
        r.skip(8);auto offsets=r.vec(4096);r.skip(size_t(offsets)*2);r.skip(8);return t;
    }
    std::vector<MaterialRow> material_data(const std::vector<MaterialType>& types){
        auto count=r.count(10000);r.count(max_input);
        std::vector<MaterialRow> rows;
        for(uint32_t i=0;i<count;i++){auto index=r.count();if(index>=types.size())r.fail("Material type reference out of bounds");MaterialRow row;row.type_name=types[size_t(index)].name;bool has_prop=false,has_vehicle=false;
            for(const auto& f:types[index].fields){size_t size=f.type<2?1:f.type<4?2:4;
                const bool albedo=f.name=="g_tAlbedo"||f.name=="g_MeshTexture";
                if(albedo){bool& seen=f.name=="g_tAlbedo"?has_prop:has_vehicle;if(seen)r.fail("Ambiguous albedo material parameter");seen=true;}
                if(albedo&&f.type==7&&f.count==1)row.actions.push_back({MaterialActionKind::Texture,f.name,r.s32(),0});
                else if(f.type==8||f.type==9){
                    for(uint32_t j=0;j<f.count;j++){r.ar();const auto ref=r.s32(),list=r.s32();if(f.type==8)row.actions.push_back({MaterialActionKind::Nested,"",ref,list});}
                    if(albedo&&f.type==9)row.actions.push_back({MaterialActionKind::Runtime,f.name,-1,0});
                }else{r.skip(size*f.count);if(albedo)row.actions.push_back({MaterialActionKind::Runtime,f.name,-1,0});}}
            rows.push_back(row);}
        return rows;
    }
    std::vector<MaterialType> material_types(){auto n=r.vec(4096);std::vector<MaterialType> types;for(uint32_t i=0;i<n;i++)types.push_back(material_type());return types;}
    void material_list(){r.ar();r.ar();auto types=material_types();material_data(types);}
    void dynamic_lists(){auto n=r.vec(256);for(uint32_t i=0;i<n;i++)if(r.pointer())material_list();}
    void empty_vector(){if(r.vec()!=0)r.fail("Streamed scene collections not supported");}
    void texture(){r.ar();r.ar();r.expect(2);auto name=r.str();auto sampler=r.ar(1);r.skip(sampler?40:36);auto hash=r.u32();auto size=r.count(max_input);textures.push_back({name,hash,r.p,size});r.skip(size);}
    void stream_data(){
        r.ar();auto version=r.ar(3);const auto n=r.vec(4096);
        for(uint32_t i=0;i<n;i++){
            const auto v=r.ar(1);r.bounds();StreamChunk c{};
            auto count=r.vec();for(uint32_t k=0;k<count;k++){r.ar();const auto b=r.s32(),lod=r.s32();if(b<0||uint32_t(b)>=resource_blocks||lod<0||lod>63)r.fail("Invalid stream item block/LOD");c.items.push_back({b,lod});}
            count=r.vec();for(uint32_t k=0;k<count;k++){auto b=r.s32();if(b<0||uint32_t(b)>=resource_blocks)r.fail("Invalid stream resource block");}
            count=r.vec();for(uint32_t k=0;k<count;k++){auto dependency=r.s32();if(dependency<0||uint32_t(dependency)>=n)r.fail("Invalid stream prerequisite");c.prerequisites.push_back(dependency);}
            count=r.vec();for(uint32_t k=0;k<count;k++){auto dependency=r.s32();if(dependency<0||uint32_t(dependency)>=n)r.fail("Invalid stream dependant");}
            c.offset=r.u64();c.stored=r.u64();c.original=v?r.u64():c.stored;
            if(c.offset>std::numeric_limits<uint64_t>::max()-c.stored)r.fail("Stream file range overflows");
            if(c.offset>9007199254740991ull||c.stored>9007199254740991ull||c.original>9007199254740991ull)r.fail("Stream numbers exceed exact browser integer range");
            stream_chunks.push_back(std::move(c));
        }
        auto count=r.vec();for(uint32_t k=0;k<count;k++)r.bitvector();
        if(version>0){count=r.vec();for(uint32_t k=0;k<count;k++)r.bounds();count=r.vec();for(uint32_t k=0;k<count;k++)r.bitvector();}
        if(version>1){count=r.vec();for(uint32_t k=0;k<count;k++)r.bitvector();}
        if(version>2)r.skip(4);
    }
    void scene_header(bool streamed=false){
        auto target_version=r.ar(1);r.ar();r.expect(2);r.ar();scene_name=r.str();r.root();
        declarations=r.vec(256);for(uint32_t i=0;i<declarations;i++){
            r.ar();auto n=r.count(32);std::vector<DeclarationElement> elements;
            for(uint32_t j=0;j<n;j++){r.ar();const auto stream=static_cast<int16_t>(r.u16());const auto offset=r.u16();const auto type=r.s32(),method=r.s32(),usage=r.s32();const auto index=static_cast<int8_t>(r.u8());elements.push_back({stream,{type,method,usage,index,offset}});}
            declaration_elements.push_back(elements);
        }
        auto effects=r.vec(256);for(uint32_t i=0;i<effects;i++){r.ar();r.ar();effect_names.push_back(r.str());}
        auto blocks=r.count(streamed?100000:256);if(!blocks)r.fail("No resource blocks");resource_blocks=blocks;
        r.ar();r.ar();r.expect(2);auto shared=r.count(4096);for(uint32_t i=0;i<shared;i++){r.str();r.skip(4);texture();}
        if(streamed)stream_data();
        else{r.ar();auto stream_version=r.ar(3);empty_vector();empty_vector();
            if(stream_version>0){empty_vector();empty_vector();}if(stream_version>1)empty_vector();if(stream_version>2)r.skip(4);}
        if(target_version>0)dynamic_lists();
        auto loaded=r.count(streamed?100000:256);if(loaded>blocks||!loaded)r.fail("Unsupported absent resource blocks");loaded_blocks=loaded;
    }
    VB vertex_buffer(){
        auto version=r.ar(1);r.ar();VB vb{};vb.stride=r.count(1024);if(!vb.stride)r.fail("Zero vertex stride");
        auto n=r.vec(32);for(uint32_t i=0;i<n;i++){r.ar();Element e{r.s32(),r.s32(),r.s32(),r.s32(),0};vb.elements.push_back(e);}
        auto offsets=r.vec(32);if(offsets!=n)r.fail("Vertex element offset count mismatch");for(auto& e:vb.elements)e.offset=r.u16();
        vb.count=r.count(1000000);size_t size=size_t(vb.stride)*vb.count;
        if(version)vb.data=r.blob(size);else{vb.data=r.p;r.skip(size);}return vb;
    }
    IB index_buffer(){auto v=r.ar(1);auto n=r.count(6000000);auto type=r.u32();if(type>1)r.fail("Unsupported index type");IB ib{n,type?4u:2u,0};if(v)ib.data=r.blob(size_t(n)*ib.width);else{ib.data=r.p;r.skip(size_t(n)*ib.width);}return ib;}
    Stream primitive_stream(){r.ar();Stream s{r.s32(),r.s32(),r.s32(),r.s32(),0,0};r.ar();s.material=r.s32();s.material_list=r.s32();return s;}
    Primitive primitive(){
        auto version=r.ar(1);Primitive p{};p.effect=r.s32();p.declaration=r.s32();p.topology=r.s32();p.ib=r.s32();r.skip(4);r.ar();p.base={r.s32(),r.s32()};if(version){r.ar();p.instance={r.s32(),r.s32()};p.has_instance=true;}r.ar();r.skip(24);
        auto n=r.vec(64);for(uint32_t i=0;i<n;i++){r.ar();p.lods.push_back({r.u32(),r.u32(),r.u32(),r.u32()});}
        n=r.vec(32);for(uint32_t i=0;i<n;i++)p.streams.push_back(primitive_stream());return p;
    }
    void instance(){r.ar();r.skip(4);r.ar();r.skip(8);auto n=r.vec(32);for(uint32_t i=0;i<n;i++)primitive_stream();r.skip(4);}
    // PvsCellData::Build leaves nCells/cellSize uninitialized when its vectors
    // are empty (renderlist.cpp). They are opaque scalars here, never allocation
    // counts. Visibility is not applied; vector extents are independently bounded.
    void pvs(){auto v=r.ar(1);r.skip(4);if(v){auto n=r.vec();r.skip(size_t(n)*2);}r.skip(4);auto n=r.vec();r.skip(n);}
    std::vector<Resource> resources(){auto n=r.vec(4096);std::vector<Resource> values;for(uint32_t i=0;i<n;i++)values.push_back({r.s32(),r.s32()});return values;}
    MaterialRef material_ref(){r.ar();return {r.s32(),r.s32()};}
    InstanceInfo parse_instance(){
        r.ar();InstanceInfo result;result.primitive_index=r.s32();result.material=material_ref();
        auto n=r.vec(32);for(uint32_t i=0;i<n;i++)result.streams.push_back(primitive_stream());
        result.flags=r.u32();return result;
    }
    std::vector<TransformRow> transform_material_data(const std::vector<MaterialType>& types,std::vector<MaterialRow>* material_rows=nullptr){
        auto count=r.count(10000);r.count(max_input);std::vector<TransformRow> rows;
        for(uint32_t i=0;i<count;i++){
            auto index=r.count();if(index>=types.size())r.fail("Material type reference out of bounds");TransformRow row;row.type_index=int32_t(index);row.type_name=types[size_t(index)].name;
            MaterialRow actions;actions.type_name=row.type_name;bool has_prop=false,has_vehicle=false;
            for(const auto& f:types[index].fields){
                TransformField field;field.name=f.name;field.type=f.type;field.count=f.count;
                const size_t size=f.type<2?1:f.type<4?2:4;
                const bool albedo=f.name=="g_tAlbedo"||f.name=="g_MeshTexture";
                if(material_rows&&albedo){bool& seen=f.name=="g_tAlbedo"?has_prop:has_vehicle;if(seen)r.fail("Ambiguous albedo material parameter");seen=true;}
                if(f.type==8||f.type==9){
                    for(uint32_t j=0;j<f.count;j++){r.ar();const MaterialRef ref{r.s32(),r.s32()};if(f.type==8){field.nested.push_back(ref);actions.actions.push_back({MaterialActionKind::Nested,"",ref.index,ref.list});}else field.runtime=true;}
                    if(albedo&&f.type==9)actions.actions.push_back({MaterialActionKind::Runtime,f.name,-1,0});
                }else if(f.type==6){
                    for(uint32_t j=0;j<f.count;j++)field.floats.push_back(r.f32_bits());
                    if(albedo)actions.actions.push_back({MaterialActionKind::Runtime,f.name,-1,0});
                }else if(albedo&&f.type==7&&f.count==1){
                    actions.actions.push_back({MaterialActionKind::Texture,f.name,r.s32(),0});
                }else{
                    r.skip(size*f.count);
                    if(albedo)actions.actions.push_back({MaterialActionKind::Runtime,f.name,-1,0});
                }
                row.fields.push_back(std::move(field));
            }
            if(material_rows)material_rows->push_back(std::move(actions));
            rows.push_back(std::move(row));
        }
        return rows;
    }
    void skip_node_body(const std::string& name,uint16_t version){
        if(name=="RenderingData::RootNode"){if(version)r.fail("Unsupported root version");r.cull();return;}
        if(name=="RenderingData::CullNode"){if(version>2)r.fail("Unsupported cull version");r.node();r.bounds();r.bitvector();if(version>0)r.skip(4);if(version>1)r.bitvector();return;}
        if(name=="RenderingData::Node"){if(version)r.fail("Unsupported node version");r.str();auto n=r.vec();r.skip(size_t(n)*8+16);return;}
        if(name=="RenderingData::GroupNode"){if(version)r.fail("Unsupported group version");r.cull();r.str();return;}
        if(name=="RenderingData::LodNode"){if(version)r.fail("Unsupported lod version");r.cull();auto n=r.vec();r.skip(size_t(n)*4);return;}
        r.fail("Unsupported polymorphic node "+name);
    }
    void parse_node_instance(){
        auto tag=r.u8();if(tag==0)return;if(tag!=3)r.fail("Unsupported polymorphic node pointer");
        auto name=r.str();auto version=r.ar(4);
        if(name=="RenderingData::RenderListNode_Common"){if(version)r.fail("Unsupported target RenderListNode version");render_lists.push_back(parse_render_list());return;}
        skip_node_body(name,version);
    }
    RenderListInfo parse_render_list(){
        RenderListInfo info;
        auto base_version=r.ar(4);if(base_version<2)r.fail("Unsupported legacy RenderListNode");
        r.cull();r.ar();auto types=material_types();material_data(types);
        auto n=r.vec(10000);for(uint32_t i=0;i<n;i++)info.primitives.push_back(primitive());
        n=r.vec(10000);for(uint32_t i=0;i<n;i++)info.instances.push_back(parse_instance());
        n=r.vec(10000);for(uint32_t i=0;i<n;i++){r.ar();parse_instance();primitive_stream();}
        n=r.vec(10000);for(uint32_t i=0;i<n;i++)info.base_primitives.push_back(primitive());
        info.constants=transform_material_data(types,&info.material_rows);
        n=r.vec(10000);for(uint32_t i=0;i<n;i++){r.ar();r.skip(24);}
        for(int group=0;group<3;group++){
            n=r.vec();for(uint32_t i=0;i<n;i++){r.ar();if(group==1){std::array<float,8> bounds{};for(int k=0;k<8;k++)bounds[size_t(k)]=r.f32_bits();info.instance_bounds.push_back(bounds);}else r.skip(32);}
        }
        for(int k=0;k<3;k++)pvs();
        n=r.vec();r.skip(size_t(n)*4);
        n=r.vec();for(uint32_t i=0;i<n;i++){r.ar();r.bitvector();r.bitvector();}
        if(base_version==3){for(int k=0;k<2;k++){r.ar();auto dynamic_types=material_types();transform_material_data(dynamic_types);}}
        else if(base_version>3){n=r.vec(256);for(uint32_t i=0;i<n;i++){r.ar();auto dynamic_types=material_types();transform_material_data(dynamic_types);}}
        info.index_sources=resources();info.vertex_sources=resources();info.texture_sources=resources();
        chunk_data();
        return info;
    }
    void apply_transform(const std::vector<TransformRow>& constants,const MaterialRef& ref,std::array<float,16>& matrix,bool& seen,std::string& error,std::vector<MaterialRef>& stack,int32_t* row){
        if(!error.empty())return;
        if(ref.list!=0){error="Runtime material transform unsupported";return;}
        if(ref.index<0||size_t(ref.index)>=constants.size()){error="Constant index out of bounds";return;}
        if(stack.size()>=32){error="Recursive material transform";return;}
        for(const auto& previous:stack)if(previous.index==ref.index&&previous.list==ref.list){error="Recursive material transform";return;}
        stack.push_back(ref);
        for(const auto& field:constants[size_t(ref.index)].fields){
            if(field.type==8){for(const auto& child:field.nested)apply_transform(constants,child,matrix,seen,error,stack,row);continue;}
            if(field.name!="g_mWorld")continue;
            if(field.type!=6||field.count!=16||field.floats.size()!=16){error="Unsupported world matrix field";continue;}
            for(int k=0;k<16;k++)if(!std::isfinite(field.floats[size_t(k)])){error="Nonfinite world matrix";break;}
            if(!error.empty())continue;
            for(int k=0;k<16;k++)matrix[size_t(k)]=field.floats[size_t(k)];
            seen=true;
            // The archived CullNode record is keyed by the placed object, not by
            // the draw. On this level one constant row supplies g_mWorld per
            // instance; two different rows would make the group key ambiguous.
            if(row){if(*row>=0&&*row!=ref.index)*row=-2;else if(*row!=-2)*row=ref.index;}
        }
        stack.pop_back();
    }
    bool world_matrix(const RenderListInfo& list,const InstanceInfo& instance,const Primitive& primitive,std::array<float,16>& matrix,std::string& error,int32_t* row=nullptr){
        bool seen=false;std::vector<MaterialRef> stack;
        apply_transform(list.constants,instance.material,matrix,seen,error,stack,row);
        for(const auto& stream:instance.streams)if(stream.index!=-1)apply_transform(list.constants,{stream.material,stream.material_list},matrix,seen,error,stack,row);
        apply_transform(list.constants,primitive.base,matrix,seen,error,stack,row);
        for(const auto& stream:primitive.streams)if(stream.index!=-1)apply_transform(list.constants,{stream.material,stream.material_list},matrix,seen,error,stack,row);
        if(!error.empty())return false;
        if(!seen){error="No explicit constant world matrix";return false;}
        if(matrix[3]!=0||matrix[7]!=0||matrix[11]!=0||matrix[15]!=1){error="Only affine world matrices supported";return false;}
        return true;
    }
    struct StreamItem {size_t start=0,end=0;std::vector<VB> vbs;std::vector<IB> ibs;};
    StreamItem parse_stream_item(size_t cursor,bool parse_lists,bool keep_geometry){
        r.p=cursor;r.origin=0;StreamItem out;out.start=cursor;
        r.ar();r.ar();r.expect(2);r.expect(0);
        auto n=r.vec(256);for(uint32_t i=0;i<n;i++){if(!r.pointer())r.fail("Null stream vertex buffer");auto vb=vertex_buffer();if(keep_geometry)out.vbs.push_back(std::move(vb));}
        n=r.vec(256);for(uint32_t i=0;i<n;i++){if(!r.pointer())r.fail("Null stream index buffer");auto ib=index_buffer();if(keep_geometry)out.ibs.push_back(std::move(ib));}
        n=r.vec(100000);if(parse_lists){for(uint32_t i=0;i<n;i++)parse_node_instance();}else{for(uint32_t i=0;i<n;i++)skip_node();}
        auto texture_count=r.count(16);for(uint32_t i=0;i<texture_count;i++){ResourceTextureInfo texture;texture_lod_metadata(texture,0);}
        out.end=r.p;return out;
    }

    // Full node skip for resource-block metadata traversal. This mirrors the
    // source-shaped Python diagnostics; it must consume ChunkData and every
    // following field so the next resource block starts at the right byte.
    void chunk_data(){
        auto n=r.vec();
        for(uint32_t i=0;i<n;i++){r.ar();r.skip(4);for(int k=0;k<3;k++){auto m=r.vec();for(uint32_t j=0;j<m;j++){r.ar();r.skip(12);}}}
    }
    void render_list_skip(){
        auto base_version=r.ar(4);if(base_version<2)r.fail("Unsupported legacy RenderListNode");
        r.cull();r.ar();auto types=material_types();material_data(types);
        auto n=r.vec(10000);for(uint32_t i=0;i<n;i++)primitive();
        n=r.vec(10000);for(uint32_t i=0;i<n;i++)instance();
        n=r.vec(10000);for(uint32_t i=0;i<n;i++){r.ar();instance();primitive_stream();}
        n=r.vec(10000);for(uint32_t i=0;i<n;i++)primitive();
        material_data(types);
        n=r.vec(10000);for(uint32_t i=0;i<n;i++){r.ar();r.skip(24);}
        for(int k=0;k<3;k++){n=r.vec();for(uint32_t i=0;i<n;i++)r.bounds();}
        for(int k=0;k<3;k++)pvs();
        n=r.vec();r.skip(size_t(n)*4);
        n=r.vec();for(uint32_t i=0;i<n;i++){r.ar();r.bitvector();r.bitvector();}
        if(base_version==3){for(int k=0;k<2;k++){r.ar();auto dynamic_types=material_types();material_data(dynamic_types);}}
        else if(base_version>3){n=r.vec(256);for(uint32_t i=0;i<n;i++){r.ar();auto dynamic_types=material_types();material_data(dynamic_types);}}
        resources();resources();resources();
        chunk_data();
    }
    void skip_node(){
        auto tag=r.u8();if(tag==0)return;if(tag!=3)r.fail("Unsupported polymorphic node pointer");
        auto name=r.str();auto version=r.ar(4);
        if(name=="RenderingData::RenderListNode_Common"){if(version)r.fail("Unsupported target RenderListNode version");render_list_skip();return;}
        skip_node_body(name,version);
    }
    void texture_lod_metadata(ResourceTextureInfo& texture,int32_t lod){
        TextureLodInfo t;t.lod=lod;t.archive_offset=r.p;
        t.version=r.ar(2);r.ar();r.expect(2);
        if(lod==0){texture.name=r.str();texture.sampler_version=r.ar(1);auto n=texture.sampler_version?10u:9u;for(uint32_t i=0;i<n;i++)texture.sampler.push_back(r.u32());texture.hash=r.u32();}
        const auto present=r.u32();t.present=present!=0;
        if(!t.present){texture.lods.push_back(std::move(t));return;}
        t.descriptor_bytes=r.count(256);t.descriptor_offset=r.p;
        if(t.descriptor_bytes==28){
            t.width=r.u32();t.height=r.u32();t.depth=r.u32();t.levels=r.u32();t.format=r.u32();t.usage=r.u32();t.type=r.u32();
            t.complete_mip_bytes=complete_mip_bytes(t.format,t.width,t.height,t.levels);
            t.supported=t.type==3&&t.depth==1&&t.width>=1&&t.width<=512&&t.height>=1&&t.height<=512&&t.levels>=1&&t.levels<=10;
            if(!t.supported)t.reason="Unsupported resource texture descriptor shape";
        }else{r.skip(t.descriptor_bytes);t.reason="Unsupported resource texture descriptor size";}
        if(present>1){
            t.paired_block=r.s32();t.paired_index=r.s32();t.supported=false;t.reason="Paired resource texture source unsupported";
        }else if(t.version){
            r.ar();const auto size=r.u32(),alignment=r.u32(),compression=r.u32();const auto swap=r.u8();
            if(!alignment||alignment>4096||(alignment&(alignment-1))||compression||swap)r.fail("Unsupported resource texture LOD buffer");
            if(r.p<r.origin)r.fail("Invalid resource texture alignment origin");
            r.skip((r.origin-r.p)%alignment);
            t.payload_offset=r.p;t.payload_bytes=size;r.skip(size);
        }else{
            t.payload_bytes=r.count(max_input);t.payload_offset=r.p;r.skip(t.payload_bytes);
        }
        if(t.complete_mip_bytes){
            if(t.payload_bytes>t.complete_mip_bytes)r.fail("Resource texture payload exceeds descriptor mip chain");
            uint64_t covered=0;
            for(uint32_t level=0;level<t.levels;level++){
                const auto bytes=mip_level_bytes(t.format,t.width,t.height,level);
                if(covered+bytes>t.payload_bytes)r.fail("Resource texture payload ends within a mip");
                covered+=bytes;t.top_mip_levels=level+1;
                if(covered==t.payload_bytes)break;
            }
            if(covered!=t.payload_bytes)r.fail("Resource texture payload exceeds descriptor mip chain");
        }
        texture.lods.push_back(std::move(t));
    }
    void resource_blocks_metadata(std::vector<ResourceBlockInfo>& blocks){
        for(uint32_t block_index=0;block_index<loaded_blocks;block_index++){
            ResourceBlockInfo block;block.index=int32_t(block_index);
            r.ar();r.ar();r.expect(2);block.lod_count=r.count(64);if(!block.lod_count)r.fail("No resource LOD");
            for(uint32_t lod=0;lod<block.lod_count;lod++){
                r.ar();r.ar();r.expect(2);r.expect(lod);
                if(lod==0){
                    auto n=r.vec(256);for(uint32_t i=0;i<n;i++){if(!r.pointer())r.fail("Null vertex buffer");vertex_buffer();}
                    n=r.vec(256);for(uint32_t i=0;i<n;i++){if(!r.pointer())r.fail("Null index buffer");index_buffer();}
                    n=r.vec(100000);for(uint32_t i=0;i<n;i++)skip_node();
                }
                auto texture_count=r.count(16);
                if(lod>0&&texture_count!=block.textures.size())r.fail("Resource texture count changes between LODs");
                if(lod==0){block.textures.resize(texture_count);for(uint32_t i=0;i<texture_count;i++)block.textures[i].index=int32_t(i);}
                for(uint32_t i=0;i<texture_count;i++)texture_lod_metadata(block.textures[i],int32_t(lod));
            }
            blocks.push_back(std::move(block));
        }
        if(r.p!=r.end)r.fail("Resource blocks do not end at the Scene boundary");
    }
    void render_tail(uint16_t version,const std::vector<MaterialType>& types){
        auto n=r.vec(10000);instance_count=n;for(uint32_t i=0;i<n;i++)instance();
        n=r.vec(10000);instance_batch_count=n;for(uint32_t i=0;i<n;i++){r.ar();instance();primitive_stream();}
        n=r.vec(10000);base_primitive_count=n;for(uint32_t i=0;i<n;i++)primitive();
        auto rows=material_data(types);
        n=r.vec(10000);for(uint32_t i=0;i<n;i++){r.ar();r.skip(24);}
        for(int k=0;k<3;k++){n=r.vec();for(uint32_t i=0;i<n;i++)r.bounds();}
        for(int k=0;k<3;k++)pvs();
        n=r.vec();r.skip(size_t(n)*4);
        if(r.vec())r.fail("Portal material traversal unsupported");
        if(version==3){for(int k=0;k<2;k++){r.ar();auto dynamic_types=material_types();material_data(dynamic_types);}}
        else if(version>3){n=r.vec(256);for(uint32_t i=0;i<n;i++){r.ar();auto dynamic_types=material_types();material_data(dynamic_types);}}
        auto indices=resources();auto vertices=resources();auto sources=resources();
        constants=std::move(rows);texture_sources=std::move(sources);index_sources=std::move(indices);vertex_sources=std::move(vertices);binding_tail=true;binding_error.clear();
        // ChunkData, following nodes, resource textures/LODs and scene transforms
        // remain outside this bounded material-binding preview.
    }
    bool node_pointer(){
        auto tag=r.u8();if(tag==0)return false;if(tag!=3)r.fail("Unsupported node pointer type");auto name=r.str();auto version=r.ar(4);
        if(name=="RenderingData::RenderListNode_Common"){
            if(version)r.fail("Unsupported target RenderListNode version");auto base_version=r.ar(4);r.cull();
            if(base_version<2)r.fail("Unsupported legacy RenderListNode");r.ar();auto types=material_types();material_data(types);
            auto n=r.vec(10000);for(uint32_t i=0;i<n;i++)primitives.push_back(primitive());
            if(primitives.empty())r.fail("First render list contains no base primitives");
            const size_t primitive_end=r.p;
            try{render_tail(base_version,types);}catch(const std::exception& error){binding_error=error.what();r.p=primitive_end;constants.clear();texture_sources.clear();vertex_sources.clear();index_sources.clear();binding_tail=false;}
            return true;
        }
        if(name=="RenderingData::RootNode"){if(version)r.fail("Unsupported root version");r.cull();return false;}
        if(name=="RenderingData::CullNode"){ // Object marker already read; inline cull fields.
            if(version>2)r.fail("Unsupported cull version");r.node();r.bounds();r.bitvector();if(version>0)r.skip(4);if(version>1)r.bitvector();return false;}
        if(name=="RenderingData::Node"){if(version)r.fail("Unsupported node version");r.str();auto n=r.vec();r.skip(size_t(n)*8+16);return false;}
        if(name=="RenderingData::GroupNode"){if(version)r.fail("Unsupported group version");r.cull();r.str();return false;}
        r.fail("Unsupported polymorphic node "+name);
    }
    void resource_prefix(){
        r.ar();r.ar();r.expect(2);auto lods=r.count(16);if(!lods)r.fail("No resource LOD");r.ar();r.ar();r.expect(2);r.expect(0);
        auto n=r.vec(256);for(uint32_t i=0;i<n;i++){if(!r.pointer())r.fail("Null vertex buffer");vbs.push_back(vertex_buffer());}
        n=r.vec(256);for(uint32_t i=0;i<n;i++){if(!r.pointer())r.fail("Null index buffer");ibs.push_back(index_buffer());}
        n=r.vec(10000);for(uint32_t i=0;i<n;i++){node_index=i;if(node_pointer())return;}
        r.fail("No supported render list in first resource block");
    }
    const Stream& position_stream(const Primitive& p,bool validate_buffer=true) {
        if(p.declaration<0||size_t(p.declaration)>=declaration_elements.size())r.fail("Invalid primitive declaration");
        const DeclarationElement* position=nullptr;
        for(const auto& element:declaration_elements[size_t(p.declaration)])if(element.value.usage==0&&element.value.index==0){if(position)r.fail("Multiple POSITION0 declarations");position=&element;}
        if(!position||position->stream<0||position->stream>15||position->value.method!=0)r.fail("Unsupported POSITION0 declaration");
        const Stream* selected=nullptr;
        std::array<bool,16> bound{};
        for(const auto& stream:p.streams){
            if(stream.index==-1)continue; // Context::SetPrimitiveStream returns before using this binding.
            if(stream.index<0||stream.index>15||bound[size_t(stream.index)]||stream.frequency!=0)r.fail("Unsupported duplicate or instanced vertex stream");
            bound[size_t(stream.index)]=true;
            if(stream.index==position->stream)selected=&stream;
        }
        if(!selected||selected->vb<0||size_t(selected->vb)>=vertex_sources.size()||selected->offset<0)r.fail("POSITION0 stream binding missing");
        if(!validate_buffer)return *selected;
        const auto& source=vertex_sources[size_t(selected->vb)];
        if(source.block!=expected_resource_block||source.index<0||size_t(source.index)>=vbs.size())r.fail("Unsupported external position buffer source");
        const auto& vb=vbs[size_t(source.index)];bool matches=false;
        for(const auto& element:vb.elements)if(element.usage==0&&element.index==0&&element.type==position->value.type&&element.method==position->value.method&&element.offset==position->value.offset)matches=true;
        if(!matches)r.fail("POSITION0 declaration does not match bound vertex format");
        return *selected;
    }
    void apply_material(const MaterialRef& ref,MaterialState& state,std::vector<MaterialRef>& stack){
        if(++material_steps>1000000)r.fail("Material evaluation limit");
        const auto unknown=[&](const char* reason){state.prop={true,false,-1,-1,reason};state.vehicle={true,false,-1,-1,reason};};
        if(ref.list!=0){unknown("Dynamic material list is rebuilt at runtime; albedo value unavailable");return;}
        if(ref.index<0||size_t(ref.index)>=constants.size()){unknown("Constant material index out of bounds");return;}
        if(stack.size()>=32)r.fail("Constant material recursion depth limit");
        for(const auto& previous:stack)if(previous.index==ref.index&&previous.list==ref.list)r.fail("Recursive constant material reference");
        stack.push_back(ref);
        for(const auto& action:constants[size_t(ref.index)].actions){
            if(++material_steps>1000000)r.fail("Material evaluation limit");
            if(action.kind==MaterialActionKind::Nested){apply_material({action.value,action.list},state,stack);continue;}
            auto& value=action.name=="g_tAlbedo"?state.prop:state.vehicle;
            if(action.kind==MaterialActionKind::Texture)value={true,true,action.value,ref.index,""};
            else value={true,false,-1,ref.index,"Albedo parameter depends on unsupported scalar shape or runtime material data"};
        }
        stack.pop_back();
    }
    bool draw_uv_available(const Primitive& p,const Stream& position,const VB& vb) {
        const DeclarationElement* declared=nullptr;
        for(const auto& e:declaration_elements[size_t(p.declaration)])if(e.value.usage==5&&e.value.index==0){if(declared)r.fail("Duplicate UV0 declaration");declared=&e;}
        if(!declared)return false;
        const auto& uv=declared->value;
        if(uv.method!=0||(uv.type!=5&&uv.type!=8&&uv.type!=9))return false;
        if(declared->stream!=position.index)return false; // Separate UV streams are not merged into this output.
        const Element* stored=nullptr;
        for(const auto& e:vb.elements)if(e.usage==5&&e.index==0){if(stored)r.fail("Duplicate UV0 semantic");stored=&e;}
        if(!stored)return false;
        if(stored->type!=uv.type||stored->method!=uv.method||stored->offset!=uv.offset)r.fail("UV0 declaration does not match bound vertex format");
        return true;
    }
    void bind_albedo(const Primitive& p,Draw& draw,bool expose_resource_parameter=false){
        if(p.effect<0||size_t(p.effect)>=effect_names.size())r.fail("Primitive effect index out of bounds");
        std::string effect=effect_names[size_t(p.effect)];for(auto& c:effect)if(c>='A'&&c<='Z')c=char(c-'A'+'a');
        const auto slash=effect.find_last_of("\\/");if(slash!=std::string::npos)effect=effect.substr(slash+1);
        const auto dot=effect.find_last_of('.');if(dot!=std::string::npos)effect.resize(dot);
        const bool vehicle=effect.compare(0,4,"veh_")==0;
        if(vehicle){
            const auto family_end=effect.find('_',4);const auto family=effect.substr(4,family_end==std::string::npos?std::string::npos:family_end-4);
            if(family=="light"){draw.binding="Vehicle light Off/On blend depends on runtime colour and UV0.xy/zw";return;}
            auto at=family_end;
            while(at!=std::string::npos){const auto next=effect.find('_',at+1);const auto flag=effect.substr(at+1,next==std::string::npos?std::string::npos:next-at-1);
                if(flag=="a"){draw.binding=(family=="paint"||family=="paintm")?"Vehicle _NO_ALBEDO paint uses a runtime paint lookup texture":"Vehicle _NO_ALBEDO shader does not sample an albedo image";return;}at=next;}
        }
        MaterialState state;std::vector<MaterialRef> stack;
        // RenderPrimitive sets instance material, then SetPrimitive applies base
        // material followed by ALL active stream materials, including zero-size
        // placeholder buffers. MATERIAL_INDEX recursively sets full materials.
        if(p.has_instance)apply_material(p.instance,state,stack);
        apply_material(p.base,state,stack);
        for(const auto& stream:p.streams)if(stream.index!=-1)apply_material({stream.material,stream.material_list},state,stack);
        const auto& value=vehicle?state.vehicle:(state.prop.seen?state.prop:state.vehicle);
        const char* parameter=vehicle||!state.prop.seen?"g_MeshTexture":"g_tAlbedo";
        draw.material_row=value.row;
        if(value.row>=0&&size_t(value.row)<constants.size())draw.material=constants[size_t(value.row)].type_name;
        if(!value.seen){draw.binding=std::string("No supported scalar ")+parameter+" TEXTURE_INDEX";return;}
        if(!value.known){draw.binding=value.reason;return;}
        if(value.value<0||size_t(value.value)>=texture_sources.size()){draw.binding="Node texture index out of bounds";return;}
        const auto& source=texture_sources[size_t(value.value)];
        if(source.block!=-1){
            if(source.block<0||uint32_t(source.block)>=resource_blocks||source.index<0){draw.binding="Resource texture block/index out of bounds";return;}
            draw.resource_block=source.block;draw.resource_index=source.index;
            if(expose_resource_parameter)draw.albedo_parameter=parameter;
            draw.binding=draw.uv_available?"Original resource-block texture input; payload metadata required":"Original UV0 unavailable for this draw; placeholder UVs are not a material mapping";
            return;
        }
        if(source.index<0||size_t(source.index)>=textures.size()){draw.binding="Shared texture index out of bounds";return;}
        if(!draw.uv_available){draw.binding="Original UV0 unavailable for this draw; placeholder UVs are not a material mapping";return;}
        draw.albedo=source.index;draw.albedo_parameter=parameter;
        draw.binding=std::string(parameter)+" via ordered instance/base/stream materials and shared texture resource";
    }
    void geometry(bool expose_resource_parameter=false){
        if(!binding_tail)r.fail("Resource source mapping unavailable: "+binding_error);
        // Buffers are concatenated once; primitive references retain their source VB.
        std::vector<uint32_t> bases(vbs.size());
        std::vector<bool> used(vbs.size());
        for(const auto& p:primitives){const auto& stream=position_stream(p);used[size_t(vertex_sources[size_t(stream.vb)].index)]=true;}
        for(size_t i=0;i<vbs.size();i++){if(!used[i])continue;const auto& vb=vbs[i];const Element* position=nullptr;const Element* uv=nullptr;for(const auto& e:vb.elements){if(e.usage==0&&e.index==0){if(position)r.fail("Duplicate position semantic");position=&e;}if(e.usage==5&&e.index==0){if(uv)r.fail("Duplicate UV0 semantic");uv=&e;}}
            // Vehicle MainVS loads F16_4 and explicitly replaces W with 1;
            // stored XYZ are already object-local positions, without a scale bias.
            const bool half_position=position&&position->type==9;
            if(!position||(position->type!=6&&!half_position)||position->method!=0||uint32_t(position->offset)+(half_position?8u:12u)>vb.stride)r.fail("Unsupported position vertex format");
            bases[i]=static_cast<uint32_t>(positions.size()/3);if(positions.size()/3+vb.count>1000000)r.fail("Output vertex limit");
            const bool has_uv=uv&&uv->method==0&&(uv->type==8||uv->type==9||uv->type==5);
            if(has_uv&&uint32_t(uv->offset)+(uv->type==8?4u:8u)>vb.stride)r.fail("UV0 exceeds vertex stride");
            if(has_uv)valid_uv_vertices+=vb.count;else placeholder_uv_vertices+=vb.count;
            size_t saved=r.p;for(uint32_t v=0;v<vb.count;v++){r.p=vb.data+size_t(v)*vb.stride+position->offset;for(int a=0;a<3;a++)positions.push_back(half_position?half(r.u16()):r.f32());if(has_uv){r.p=vb.data+size_t(v)*vb.stride+uv->offset;for(int a=0;a<2;a++)uvs.push_back(uv->type==5?r.f32():half(r.u16()));}else{uvs.push_back(0);uvs.push_back(0);}}r.p=saved;
        }
        for(const auto& p:primitives){const auto first=static_cast<uint32_t>(triangles.size());if(p.declaration<0||uint32_t(p.declaration)>=declarations||p.ib<0||size_t(p.ib)>=index_sources.size()||p.lods.empty())r.fail("Invalid primitive resource reference");if(p.topology!=0&&p.topology!=1)r.fail("Unsupported primitive topology");
            // POSITION0 follows its declaration's stream, not stream-array order.
            // Secondary tangent/damage streams are not applied in this diagnostic.
            const auto& s=position_stream(p);
            const auto& vr=vertex_sources[size_t(s.vb)];const auto& ir=index_sources[size_t(p.ib)];
            if(vr.block!=expected_resource_block||ir.block!=expected_resource_block||vr.index<0||ir.index<0||size_t(vr.index)>=vbs.size()||size_t(ir.index)>=ibs.size())r.fail("Unsupported external vertex/index resource source");
            const auto& vb=vbs[size_t(vr.index)];const auto& ib=ibs[size_t(ir.index)];const auto& lod=p.lods[0];if(uint32_t(s.offset)%vb.stride)r.fail("Unaligned vertex stream byte offset");const uint32_t vertex_shift=uint32_t(s.offset)/vb.stride;
            if(lod.offset>ib.count||lod.count>ib.count-lod.offset||lod.min>vb.count||lod.vertices>vb.count-lod.min||vertex_shift>vb.count)r.fail("Primitive range exceeds buffer");
            if(p.topology==0&&lod.count%3)r.fail("Invalid triangle list index count");std::vector<uint32_t> values;size_t saved=r.p;
            for(uint32_t j=0;j<lod.count;j++){r.p=ib.data+size_t(lod.offset+j)*ib.width;auto index=ib.width==2?r.u16():r.u32();if(index<lod.min||index>=lod.min+lod.vertices||index>=vb.count-vertex_shift)r.fail("Index outside primitive vertex range");values.push_back(index+bases[size_t(vr.index)]+vertex_shift);}r.p=saved;
            const uint32_t step=p.topology==0?3u:1u;for(uint32_t j=2;j<values.size();j+=step){auto a=values[j-2],b=values[j-1],c=values[j];if(p.topology==1&&j%2)std::swap(a,b);if(a==b||b==c||a==c)continue;if(triangles.size()>6000000-3)r.fail("Output triangle limit");triangles.insert(triangles.end(),{a,b,c});}
            Draw draw{first,static_cast<uint32_t>(triangles.size())-first,-1,""};
            draw.uv_available=draw_uv_available(p,s,vb);bind_albedo(p,draw,expose_resource_parameter);
            if(draw.uv_available){draw.uv_hash=uv_range_hash(uvs,triangles,draw.first,draw.count);draw.uv_hashed=true;}
            if(draw.albedo>=0)draw.binding_status=draw.uv_available?"static-shared-albedo-resolved":"blocked";
            else if(draw.resource_block>=0&&draw.resource_index>=0)draw.binding_status=draw.uv_available?"static-resource-albedo-resolved":"blocked";
            else draw.binding_status="blocked";
            if(draw.binding_status=="blocked")draw.binding_reason=draw.binding;
            draws.push_back(draw);
        }
        if(triangles.empty())r.fail("No nondegenerate triangles");
    }
    std::string run(){
        r.literal("  CP",4);auto model=chunk(r,4,r.end);if(model.id!="Model")r.fail("Expected Model container");auto render=child(r,model,"Render");if(render.type!=0x41)r.fail("Expected Render wrapper");auto inner=chunk(r,render.payload,render.end);if(inner.id!="Render"||inner.end!=render.end)r.fail("Invalid inner Render");auto header=child(r,inner,"Header");r.p=header.payload;if(header.end-header.payload!=4||r.u32()!=0)r.fail("Unsupported render header");auto scene=child(r,inner,"Scene");r.end=scene.end;r.p=scene.payload;r.origin=scene.payload;
        r.literal("ARCH",4);r.expect(1);r.expect(0);r.literal("ARCH",4);r.expect(0);r.expect(1);
        scene_header();resource_prefix();geometry();
        std::array<float,3> lo{INFINITY,INFINITY,INFINITY},hi{-INFINITY,-INFINITY,-INFINITY};for(size_t i=0;i<positions.size();i++){lo[i%3]=std::min(lo[i%3],positions[i]);hi[i%3]=std::max(hi[i%3],positions[i]);}
        std::ostringstream out;out.imbue(std::locale::classic());out<<std::setprecision(std::numeric_limits<float>::max_digits10)<<"{\"status\":\"ok\",\"positions\":[";
        for(size_t i=0;i<positions.size();i++){if(i)out<<',';out<<positions[i];}out<<"],\"indices\":[";for(size_t i=0;i<triangles.size();i++){if(i)out<<',';out<<triangles[i];}
        out<<"],\"uv0\":[";for(size_t i=0;i<uvs.size();i++){if(i)out<<',';out<<uvs[i];}out<<"],\"sharedTextures\":[";for(size_t i=0;i<textures.size();i++){if(i)out<<',';const auto&t=textures[i];out<<"{\"name\":\""<<escape(t.name.c_str())<<"\",\"hash\":"<<t.hash<<",\"dataOffset\":"<<t.offset<<",\"dataBytes\":"<<t.bytes<<'}';}
        out<<"],\"draws\":[";for(size_t i=0;i<draws.size();i++){if(i)out<<',';const auto&d=draws[i];out<<"{\"firstIndex\":"<<d.first<<",\"indexCount\":"<<d.count<<",\"albedoTexture\":";if(d.albedo<0)out<<"null";else out<<d.albedo;out<<",\"binding\":\""<<escape(d.binding.c_str())<<"\",\"uv0Available\":"<<(d.uv_available?"true":"false")<<",\"albedoParameter\":";if(d.albedo_parameter.empty())out<<"null";else out<<'\"'<<d.albedo_parameter<<'\"';out<<",\"resourceBlock\":";if(d.resource_block<0)out<<"null";else out<<d.resource_block;out<<",\"resourceIndex\":";if(d.resource_index<0)out<<"null";else out<<d.resource_index;out<<'}';}
        out<<"],\"bounds\":{\"min\":["<<lo[0]<<','<<lo[1]<<','<<lo[2]<<"],\"max\":["<<hi[0]<<','<<hi[1]<<','<<hi[2]<<"]},\"metadata\":{\"fixtureOnly\":false,\"partialSceneTraversal\":true,\"resourceBlock\":0,\"nodeIndex\":"<<node_index<<",\"vertexCount\":"<<positions.size()/3<<",\"triangleCount\":"<<triangles.size()/3<<",\"primitiveCount\":"<<primitives.size()<<",\"uv0ValidVertices\":"<<valid_uv_vertices<<",\"uv0PlaceholderVertices\":"<<placeholder_uv_vertices<<",\"uv0PlaceholderPolicy\":\"zero pairs; unavailable draws cannot bind albedo\",\"runtimeMaterialsApplied\":false,\"runtimePaintColourRecovered\":false,\"runtimePaintTextureRecovered\":false,\"parsedUntilOffset\":"<<r.p<<",\"coordinateSpace\":\"object-local\",\"nodeTransformsApplied\":false,\"material\":\"diagnostic-only\",\"scope\":\"first resource block first render list base primitives LOD0\"}}";return out.str();
    }
};
std::string scene_resource_textures(const unsigned char* data,size_t length){
    if(!data||length<20||length>max_input)throw std::runtime_error("Input outside supported bounds");
    Decoder d{{data,length}};
    auto& r=d.r;
    r.literal("  CP",4);auto model=chunk(r,4,r.end);if(model.id!="Model")r.fail("Expected Model container");
    auto render=child(r,model,"Render");if(render.type!=0x41)r.fail("Expected Render wrapper");
    auto inner=chunk(r,render.payload,render.end);if(inner.id!="Render"||inner.end!=render.end)r.fail("Invalid inner Render");
    auto header=child(r,inner,"Header");r.p=header.payload;if(header.end-header.payload!=4||r.u32()!=0)r.fail("Unsupported render header");
    auto scene=child(r,inner,"Scene");r.end=scene.end;r.p=scene.payload;r.origin=scene.payload;
    r.literal("ARCH",4);r.expect(1);r.expect(0);r.literal("ARCH",4);r.expect(0);r.expect(1);
    d.scene_header();
    const size_t resource_payload=r.p,scene_end=r.end;
    std::vector<ResourceBlockInfo> blocks;
    d.resource_blocks_metadata(blocks);
    std::ostringstream out;out.imbue(std::locale::classic());out<<std::setprecision(std::numeric_limits<float>::max_digits10);
    out<<"{\"status\":\"ok\",\"sceneBytes\":"<<length<<",\"resourcePayloadOffset\":"<<resource_payload<<",\"sceneEnd\":"<<scene_end
       <<",\"resourceBlockCount\":"<<d.resource_blocks<<",\"loadedResourceBlocks\":"<<d.loaded_blocks<<",\"resourceBlocks\":[";
    for(size_t b=0;b<blocks.size();b++){
        if(b)out<<',';const auto&block=blocks[b];
        out<<"{\"index\":"<<block.index<<",\"lodCount\":"<<block.lod_count<<",\"textures\":[";
        for(size_t t=0;t<block.textures.size();t++){
            if(t)out<<',';const auto&texture=block.textures[t];
            out<<"{\"index\":"<<texture.index<<",\"name\":\""<<escape(texture.name.c_str())<<"\",\"hash\":"<<texture.hash<<",\"sampler\":{\"version\":"<<texture.sampler_version<<",\"values\":[";
            for(size_t v=0;v<texture.sampler.size();v++){if(v)out<<',';out<<texture.sampler[v];}out<<"]},\"lods\":[";
            for(size_t l=0;l<texture.lods.size();l++){
                if(l)out<<',';const auto&lod=texture.lods[l];
                out<<"{\"lod\":"<<lod.lod<<",\"present\":"<<(lod.present?"true":"false")<<",\"version\":"<<lod.version<<",\"archiveOffset\":"<<lod.archive_offset;
                out<<",\"descriptorOffset\":";if(lod.descriptor_bytes)out<<lod.descriptor_offset;else out<<"null";
                out<<",\"descriptorBytes\":";if(lod.descriptor_bytes)out<<lod.descriptor_bytes;else out<<"null";
                out<<",\"descriptor\":";if(lod.descriptor_bytes==28)out<<"{\"width\":"<<lod.width<<",\"height\":"<<lod.height<<",\"depth\":"<<lod.depth<<",\"levels\":"<<lod.levels<<",\"format\":"<<lod.format<<",\"usage\":"<<lod.usage<<",\"type\":"<<lod.type<<'}';else out<<"null";
                out<<",\"payloadOffset\":";if(lod.present)out<<lod.payload_offset;else out<<"null";
                out<<",\"payloadBytes\":";if(lod.present)out<<lod.payload_bytes;else out<<"null";
                out<<",\"completeMipBytes\":";if(lod.complete_mip_bytes)out<<lod.complete_mip_bytes;else out<<"null";
                out<<",\"topMipLevels\":"<<lod.top_mip_levels;
                out<<",\"pairedBlock\":";if(lod.paired_block<0)out<<"null";else out<<lod.paired_block;
                out<<",\"pairedIndex\":";if(lod.paired_index<0)out<<"null";else out<<lod.paired_index;
                out<<",\"supported\":"<<(lod.supported?"true":"false")<<",\"reason\":";
                if(lod.reason.empty())out<<"null";else out<<'\"'<<escape(lod.reason.c_str())<<'\"';
                out<<'}';
            }
            out<<"]}";
        }
        out<<"]}";
    }
    out<<"],\"metadata\":{\"partialSceneTraversal\":true,\"resourceMetadataOnly\":true,\"geometryImported\":false,\"materialsApplied\":false,\"integrityValidated\":false,\"parsedUntilOffset\":"<<r.p
       <<",\"scope\":\"all loaded resource blocks and texture LOD descriptors; geometry/material/instance import not performed\"}}";
    return out.str();
}
Chunk level_fileblock(Reader& r,size_t start,size_t parent_end){
    r.p=start;r.need(16);size_t n=0;while(n<8&&r.b[start+n]){if(r.b[start+n]<32||r.b[start+n]>126)r.fail("Invalid level FileBlock ID");++n;}
    if(n==0||n==8)r.fail("Unterminated level FileBlock ID");
    const std::string id(reinterpret_cast<const char*>(r.b+start),n);
    // C_BlockHeaderId is C_String8: bytes after its first NUL are not part of
    // the name. Real river LS has stale bytes "ID" after NUL; do not reject it.
    r.p=start+8;const auto size=r.u32();const auto count=r.u16();const auto type=r.u8(),compression=r.u8();
    if(size<16||start>parent_end||size>parent_end-start||compression||(type!=0x41&&type!=0x43))r.fail("Unsupported level FileBlock bounds/type/compression");
    return {start,start+size,start+16,count,type,id};
}
void level_scene_header(Decoder& d){
    auto& r=d.r;r.literal("  CP",4);auto render=level_fileblock(r,4,r.end);
    if(render.id!="Render")r.fail("Expected level Render FileBlock");
    Chunk header{},scene{};bool got_header=false,got_scene=false;size_t at=render.payload;uint32_t children=0;
    // C_RenderLevel traverses by lengths: real PC Render is type0x41/count0.
    while(at<render.end){
        if(++children>10000)r.fail("Level FileBlock child limit");auto c=level_fileblock(r,at,render.end);at=c.end;
        if(c.id=="Header"){if(got_header)r.fail("Duplicate level Header");header=c;got_header=true;}
        if(c.id=="Scene"){if(got_scene)r.fail("Duplicate level Scene");scene=c;got_scene=true;}
    }
    if(!got_header||!got_scene||header.type!=0x41||scene.type!=0x41)r.fail("Missing level Header or Scene data block");
    Reader hr{r.b,header.end,header.payload};const auto version=hr.u32();
    if(version>1)hr.fail("Unsupported level render Header version");
    if(version)hr.str(); // Util::C_String EffectVariation, not a bare enum/U32.
    if(hr.p!=header.end)hr.fail("Level render Header size mismatch");
    r.p=scene.payload;r.end=scene.end;r.origin=scene.payload;
    r.literal("ARCH",4);r.expect(1);r.expect(0);r.literal("ARCH",4);r.expect(0);r.expect(1);
    d.scene_header(true);
}
const StreamChunk& selected_chunk(const Decoder& d,int32_t block,size_t supplied_size){
    if(block<0||uint32_t(block)>=d.resource_blocks)throw std::runtime_error("Level resource block ID outside Scene table");
    const StreamChunk* result=nullptr;
    for(const auto& c:d.stream_chunks)if(!c.items.empty()&&c.items[0].block==block&&c.items[0].lod==0){
        if(result)throw std::runtime_error("Ambiguous first-LOD0 level chunk binding");result=&c;
    }
    if(!result)throw std::runtime_error("No stream chunk starts with the requested block LOD0");
    if(result->stored!=supplied_size)throw std::runtime_error("Supplied level chunk length differs from ChunkInfo stored size");
    if(!result->prerequisites.empty())throw std::runtime_error("Selected level chunk needs additional prerequisites");
    return *result;
}
void stream_begin(Reader& r,const StreamChunk& record){
    r.origin=0;r.literal("ARCH",4);r.expect(1);r.expect(0);r.literal("ARCH",4);r.expect(0);
    if(r.count()!=record.items.size())r.fail("Stream item count differs from Scene ChunkInfo");
    r.ar();r.ar();r.expect(2);r.expect(0); // first LodReader<Resources>, PC LOD0
}
std::string level_index(const unsigned char* data,size_t length){
    if(!data||length<20||length>level_input_limit)throw std::runtime_error("Level input outside 20-byte to 16-MiB limit");
    Decoder d{{data,length}};level_scene_header(d);
    std::ostringstream out;out.imbue(std::locale::classic());
    out<<"{\"status\":\"ok\",\"resourceBlockCount\":"<<d.resource_blocks<<",\"initiallyLoadedBlocks\":"<<d.loaded_blocks<<",\"streamChunks\":[";
    for(size_t i=0;i<d.stream_chunks.size();++i){if(i)out<<',';const auto& c=d.stream_chunks[i];
        out<<"{\"offset\":"<<c.offset<<",\"storedBytes\":"<<c.stored<<",\"logicalBytes\":"<<c.original<<",\"items\":[";
        for(size_t j=0;j<c.items.size();++j){if(j)out<<',';out<<"{\"block\":"<<c.items[j].block<<",\"lod\":"<<c.items[j].lod<<'}';}
        out<<"],\"prerequisites\":[";for(size_t j=0;j<c.prerequisites.size();++j){if(j)out<<',';out<<c.prerequisites[j];}out<<"]}";
    }
    out<<"],\"metadata\":{\"streamIndexOnly\":true,\"integrityValidated\":false,\"parsedUntilOffset\":"<<d.r.p<<",\"scope\":\"Scene declarations and ChunkInfo records; resource blocks not imported\"}}";
    return out.str();
}
std::string level_mesh(const unsigned char* level,size_t level_size,const unsigned char* geometry_bytes,size_t geometry_size,
                       const unsigned char* node_bytes,size_t node_size,int32_t geometry_block,int32_t node_block){
    if(!level||!geometry_bytes||!node_bytes||level_size<20||geometry_size<40||node_size<40||
        level_size>level_input_limit||geometry_size>level_input_limit||node_size>level_input_limit)
        throw std::runtime_error("Level/geometry/node inputs outside bounded 16-MiB limits");
    if(geometry_block==node_block)throw std::runtime_error("Geometry and node chunks must identify distinct resource blocks");
    Decoder header{{level,level_size}};level_scene_header(header);
    const auto& geometry_record=selected_chunk(header,geometry_block,geometry_size);
    const auto& node_record=selected_chunk(header,node_block,node_size);
    Decoder mesh{{geometry_bytes,geometry_size}};stream_begin(mesh.r,geometry_record);
    auto n=mesh.r.vec(256);for(uint32_t i=0;i<n;++i){if(!mesh.r.pointer())mesh.r.fail("Null level vertex buffer");mesh.vbs.push_back(mesh.vertex_buffer());}
    n=mesh.r.vec(256);for(uint32_t i=0;i<n;++i){if(!mesh.r.pointer())mesh.r.fail("Null level index buffer");mesh.ibs.push_back(mesh.index_buffer());}
    if(mesh.r.vec()!=0)mesh.r.fail("Geometry chunk first resource has node payloads; unsupported mixed block");
    if(mesh.r.count(16)!=0)mesh.r.fail("Geometry chunk first resource textures unsupported");
    const auto geometry_parsed=mesh.r.p;
    Decoder nodes{{node_bytes,node_size}};stream_begin(nodes.r,node_record);
    if(nodes.r.vec()!=0||nodes.r.vec()!=0)nodes.r.fail("Node chunk first resource contains geometry; unsupported mixed block");
    n=nodes.r.vec(10000);bool found=false;
    for(uint32_t i=0;i<n;++i){nodes.node_index=i;if(nodes.node_pointer()){found=true;break;}}
    if(!found||!nodes.binding_tail)nodes.r.fail("Level node RenderList/source mapping unavailable: "+nodes.binding_error);
    mesh.declarations=header.declarations;mesh.declaration_elements=std::move(header.declaration_elements);mesh.effect_names=std::move(header.effect_names);
    mesh.expected_resource_block=geometry_block;mesh.vertex_sources=std::move(nodes.vertex_sources);mesh.index_sources=std::move(nodes.index_sources);
    mesh.texture_sources=std::move(nodes.texture_sources);mesh.constants=std::move(nodes.constants);mesh.binding_tail=true;
    // Shared texture identities resolve against the levelrender Scene list that
    // the node chunk references; the node chunk itself carries no shared list.
    // The geometry decoder performs the binding, so it needs the level Scene
    // block count for the resource-block range check as well.
    mesh.textures=header.textures;mesh.resource_blocks=header.resource_blocks;
    uint32_t omitted=0;
    for(const auto& p:nodes.primitives){
        const auto& stream=mesh.position_stream(p,false);
        if(p.ib<0||size_t(p.ib)>=mesh.index_sources.size())mesh.r.fail("Invalid level primitive index source");
        if(mesh.vertex_sources[size_t(stream.vb)].block!=geometry_block||mesh.index_sources[size_t(p.ib)].block!=geometry_block){++omitted;continue;}
        mesh.primitives.push_back(p);
    }
    if(mesh.primitives.empty())mesh.r.fail("No direct primitive binds selected level geometry block");
    mesh.geometry(true);
    std::array<float,3> lo{INFINITY,INFINITY,INFINITY},hi{-INFINITY,-INFINITY,-INFINITY};
    for(size_t i=0;i<mesh.positions.size();++i){lo[i%3]=std::min(lo[i%3],mesh.positions[i]);hi[i%3]=std::max(hi[i%3],mesh.positions[i]);}
    std::ostringstream out;out.imbue(std::locale::classic());out<<std::setprecision(std::numeric_limits<float>::max_digits10);
    out<<"{\"status\":\"ok\",\"positions\":[";
    for(size_t i=0;i<mesh.positions.size();++i){if(i)out<<',';out<<mesh.positions[i];}out<<"],\"indices\":[";
    for(size_t i=0;i<mesh.triangles.size();++i){if(i)out<<',';out<<mesh.triangles[i];}out<<"],\"uv0\":[";
    for(size_t i=0;i<mesh.uvs.size();++i){if(i)out<<',';out<<mesh.uvs[i];}out<<"],\"sharedTextures\":[";for(size_t i=0;i<mesh.textures.size();++i){if(i)out<<',';const auto&t=mesh.textures[i];out<<"{\"name\":\""<<escape(t.name.c_str())<<"\",\"hash\":"<<t.hash<<",\"dataOffset\":"<<t.offset<<",\"dataBytes\":"<<t.bytes<<'}';}out<<"],\"draws\":[";
    for(size_t i=0;i<mesh.draws.size();++i){if(i)out<<',';write_draw_json(out,mesh.draws[i]);}
    out<<"],\"bounds\":{\"min\":["<<lo[0]<<','<<lo[1]<<','<<lo[2]<<"],\"max\":["<<hi[0]<<','<<hi[1]<<','<<hi[2]<<"]},\"metadata\":{\"fixtureOnly\":false,\"partialSceneTraversal\":true,"
       <<"\"geometryBlock\":"<<geometry_block<<",\"nodeBlock\":"<<node_block<<",\"nodeIndex\":"<<nodes.node_index
       <<",\"vertexCount\":"<<mesh.positions.size()/3<<",\"triangleCount\":"<<mesh.triangles.size()/3<<",\"primitiveCount\":"<<mesh.primitives.size()
       <<",\"omittedOtherBlockPrimitives\":"<<omitted<<",\"instanceDescriptionsSkipped\":"<<nodes.instance_count<<",\"instanceBatchDescriptionsSkipped\":"<<nodes.instance_batch_count
       <<",\"instanceBasePrimitivesSkipped\":"<<nodes.base_primitive_count<<",\"instancesApplied\":false,\"nodeTransformsApplied\":false,\"coordinateSpace\":\"source-level\",\"material\":\"static-albedo-identity-only\",\"materialAlbedoResolved\":true,\"materialColourApplied\":false,\"blendStateApplied\":false,\"alphaRuleApplied\":false,\"shaderStagesApplied\":false,\"samplerStateApplied\":false,"
       <<"\"sceneHeaderParsedUntilOffset\":"<<header.r.p<<",\"geometryParsedUntilOffset\":"<<geometry_parsed<<",\"nodeParsedUntilOffset\":"<<nodes.r.p
       <<",\"geometryStreamOffset\":"<<geometry_record.offset<<",\"nodeStreamOffset\":"<<node_record.offset
       <<",\"integrityValidated\":false,\"scope\":\"first node-chunk RenderList direct LOD0 primitives bound to selected geometry block; static g_tAlbedo identity and UV0 are exported; texture format, alpha, blend, shader stages, sampler state, instances and later resource items are not applied\"}}";
    return out.str();
}
std::string escape(const char* text){std::string out;for(const unsigned char* p=reinterpret_cast<const unsigned char*>(text);*p;p++){if(*p=='"'||*p=='\\')out+='\\';if(*p>=32)out+=char(*p);else out+=' ';}return out;}
std::string hex16(uint64_t value){static const char digits[]="0123456789abcdef";std::string out(16,'0');for(int i=15;i>=0;i--){out[size_t(i)]=digits[value&15];value>>=4;}return out;}
// P45/P47 UV0 hash: FNV-1a 64 over the little-endian float32 bit patterns,
// repeated for every index in the draw's referenced range (duplicates included).
uint64_t uv_range_hash(const std::vector<float>& uv,const std::vector<uint32_t>& indices,uint32_t first,uint32_t count){
    uint64_t digest=0xCBF29CE484222325ull;
    for(uint32_t j=first;j<first+count;j++){
        const uint32_t vertex=indices[size_t(j)];
        for(int axis=0;axis<2;axis++){
            uint32_t bits;std::memcpy(&bits,&uv[size_t(vertex)*2+size_t(axis)],4);
            for(int byte=0;byte<4;byte++){digest^=uint8_t(bits>>(byte*8));digest*=0x100000001B3ull;}
        }
    }
    return digest;
}
uint64_t uv_stream_hash(const std::vector<float>& uv){
    uint64_t digest=0xCBF29CE484222325ull;
    for(const float value:uv){
        uint32_t bits;std::memcpy(&bits,&value,4);
        for(int byte=0;byte<4;byte++){digest^=uint8_t(bits>>(byte*8));digest*=0x100000001B3ull;}
    }
    return digest;
}
char* copy(const std::string& s){auto* p=static_cast<char*>(std::malloc(s.size()+1));if(p)std::memcpy(p,s.c_str(),s.size()+1);return p;}
}
struct InstanceGeometryTarget {
    int32_t block=0;
    size_t chunk_index=0,item_index=0;
    uint64_t stream_offset=0;
    const unsigned char* data=nullptr;
    std::vector<VB> vbs;std::vector<IB> ibs;
};
bool find_geometry_item(const Decoder& header,int32_t block,size_t& chunk_index,size_t& item_index){
    bool found=false;
    for(size_t c=0;c<header.stream_chunks.size();c++)for(size_t i=0;i<header.stream_chunks[c].items.size();i++){
        const auto& item=header.stream_chunks[c].items[i];
        if(item.block==block&&item.lod==0){
            if(found)throw std::runtime_error("Ambiguous geometry block/LOD0 stream item");
            chunk_index=c;item_index=i;found=true;
        }
    }
    return found;
}
InstanceGeometryTarget parse_geometry_target(const StreamChunk& record,const unsigned char* bytes,size_t size,
                                             int32_t block,size_t chunk_index,size_t item_index){
    if(record.stored!=size)throw std::runtime_error("Supplied geometry chunk length differs from ChunkInfo stored size");
    if(!record.prerequisites.empty())throw std::runtime_error("Selected geometry chunk needs additional prerequisites");
    Decoder geo{{bytes,size}};auto& gr=geo.r;
    gr.literal("ARCH",4);gr.expect(1);gr.expect(0);gr.literal("ARCH",4);gr.expect(0);
    if(gr.count()!=record.items.size())gr.fail("Geometry stream item count differs from Scene ChunkInfo");
    InstanceGeometryTarget target;target.block=block;target.chunk_index=chunk_index;target.item_index=item_index;
    target.stream_offset=record.offset;target.data=bytes;
    size_t cursor=24;bool found=false;
    for(size_t i=0;i<record.items.size();i++){
        auto item=geo.parse_stream_item(cursor,false,i==item_index);
        if(i==item_index){target.vbs=std::move(item.vbs);target.ibs=std::move(item.ibs);found=true;break;}
        cursor=item.end;
    }
    if(!found)throw std::runtime_error("Target geometry item was not reached");
    if(target.vbs.empty()||target.ibs.empty())throw std::runtime_error("Target geometry item has no vertex/index buffers");
    return target;
}
std::string level_instances_core(const unsigned char* level,size_t level_size,
                                 const unsigned char* node_bytes,size_t node_size,
                                 const int32_t* geometry_blocks,
                                 const unsigned char* const* geometry_bytes,
                                 const size_t* geometry_sizes,
                                 size_t geometry_count,
                                 int32_t node_block,bool all_instances,bool bundled){
    if(!level||!node_bytes||!geometry_blocks||!geometry_bytes||!geometry_sizes||
        level_size<20||node_size<40||level_size>level_input_limit||node_size>level_input_limit)
        throw std::runtime_error("Level/geometry/node inputs outside bounded 16-MiB limits");
    if(geometry_count<1||geometry_count>16)throw std::runtime_error("Geometry bundle count outside 1..16 bound");
    for(size_t k=0;k<geometry_count;k++){
        if(!geometry_bytes[k]||geometry_sizes[k]<40||geometry_sizes[k]>level_input_limit)
            throw std::runtime_error("Level/geometry/node inputs outside bounded 16-MiB limits");
        if(geometry_blocks[k]==node_block)throw std::runtime_error("Geometry and node chunks must identify distinct resource blocks");
        for(size_t j=0;j<k;j++)if(geometry_blocks[k]==geometry_blocks[j])throw std::runtime_error("Duplicate geometry block in bundle");
    }
    Decoder header{{level,level_size}};level_scene_header(header);
    std::vector<InstanceGeometryTarget> targets;targets.reserve(geometry_count);
    std::map<int32_t,size_t> target_by_block;
    for(size_t k=0;k<geometry_count;k++){
        size_t chunk_index=0,item_index=0;
        if(!find_geometry_item(header,geometry_blocks[k],chunk_index,item_index))
            throw std::runtime_error("Geometry block LOD0 absent from Scene ChunkInfo");
        targets.push_back(parse_geometry_target(header.stream_chunks[chunk_index],geometry_bytes[k],geometry_sizes[k],
                                                geometry_blocks[k],chunk_index,item_index));
        target_by_block[geometry_blocks[k]]=k;
    }
    const auto& node_record=selected_chunk(header,node_block,node_size);
    size_t node_chunk_index=0;for(size_t c=0;c<header.stream_chunks.size();c++)if(&header.stream_chunks[c]==&node_record)node_chunk_index=c;

    Decoder nodes{{node_bytes,node_size}};auto& nr=nodes.r;
    nr.literal("ARCH",4);nr.expect(1);nr.expect(0);nr.literal("ARCH",4);nr.expect(0);
    if(nr.count()!=node_record.items.size())nr.fail("Node stream item count differs from Scene ChunkInfo");
    nodes.parse_stream_item(24,true,false);
    if(nodes.render_lists.empty())throw std::runtime_error("No supported RenderList in selected node chunk");
    const auto& list=nodes.render_lists[0];
    if(list.instances.empty())throw std::runtime_error("First RenderList contains no instances");
    if(list.base_primitives.empty())throw std::runtime_error("First RenderList contains no base primitives");
    // The source node chunk does not carry the scene-wide shared texture names or
    // resource-block table. Bind the instance material stack against the level
    // Scene header's effect list while keeping the node's own render-list rows and
    // texture source table. Every value stays traceable to the original archive.
    nodes.constants=list.material_rows;
    nodes.texture_sources=list.texture_sources;
    nodes.effect_names=header.effect_names;
    nodes.textures=header.textures;
    nodes.resource_blocks=header.resource_blocks;

    struct Proof {
        int32_t index=0,base=0,vbBlock=0,ibBlock=0;
        std::array<float,16> matrix{};
        std::array<double,3> low{},high{};
        double error=0;uint32_t first=0,count=0,vertexCount=0;
        bool uv_available=false,uv_hashed=false;uint64_t uv_hash=0;std::string uv_reason;
        int32_t uv_type=-1,uv_offset=-1,uv_stride=-1;
        int32_t material_row=-1;std::string material;
        int32_t albedo_index=-1;
        std::string albedo_parameter;int32_t resource_block=-1,resource_index=-1;
        std::string binding_status="blocked",binding_reason,binding;
    };
    struct SourceInfo {int32_t index=0,vbBlock=0,vbIndex=0,ibBlock=0,ibIndex=0;};
    struct Meta {
        size_t index=0;int32_t base=0;
        const Primitive* primitive=nullptr;const Stream* selected=nullptr;const DeclarationElement* position=nullptr;const DeclarationElement* uv=nullptr;
        SourceInfo source;
        bool in_scope=false;
        std::array<float,8> archived{};
        std::array<float,16> matrix{};
        int32_t row=-1;
    };
    struct Group {
        size_t first=0,count=0,in_scope=0;
        std::array<float,8> archived{};
        int32_t row=-1;
        std::array<double,3> low{INFINITY,INFINITY,INFINITY},high{-INFINITY,-INFINITY,-INFINITY};
        double error=0;
        const char* status="other-block";
    };

    // First pass: resolve every instance's resource identity, transform row and
    // archived CullNode record. Matrix errors on blocks outside the supplied
    // bundle are not fatal; they only prevent that instance from joining a group
    // that can be validated.
    std::vector<Meta> metas;metas.reserve(all_instances?list.instances.size():1);
    std::vector<SourceInfo> sources;const size_t target_count=all_instances?list.instances.size():1;
    sources.reserve(target_count);
    for(size_t instance_index=0;instance_index<target_count;instance_index++){
        const auto& instance=list.instances[instance_index];
        if(instance.primitive_index<0||size_t(instance.primitive_index)>=list.base_primitives.size())throw std::runtime_error("Instance base primitive index out of bounds");
        const auto& primitive=list.base_primitives[size_t(instance.primitive_index)];
        if(primitive.declaration<0||size_t(primitive.declaration)>=header.declaration_elements.size())throw std::runtime_error("Primitive declaration out of bounds");
        const DeclarationElement* position=nullptr;
        for(const auto& element:header.declaration_elements[size_t(primitive.declaration)])if(element.value.usage==0&&element.value.index==0){if(position)throw std::runtime_error("Multiple POSITION0 declarations");position=&element;}
        if(!position||position->stream<0||position->stream>15||position->value.method!=0)throw std::runtime_error("Unsupported POSITION0 declaration");
        const DeclarationElement* uv=nullptr;
        for(const auto& element:header.declaration_elements[size_t(primitive.declaration)])if(element.value.usage==5&&element.value.index==0){if(uv)throw std::runtime_error("Multiple UV0 declarations");uv=&element;}
        std::array<const Stream*,16> streams{};
        for(const auto& stream:instance.streams)if(stream.index!=-1){if(stream.index<0||stream.index>15)throw std::runtime_error("Instance stream index out of bounds");streams[size_t(stream.index)]=&stream;}
        for(const auto& stream:primitive.streams)if(stream.index!=-1){if(stream.index<0||stream.index>15)throw std::runtime_error("Primitive stream index out of bounds");streams[size_t(stream.index)]=&stream;}
        const Stream* selected=streams[size_t(position->stream)];
        if(!selected)throw std::runtime_error("POSITION0 instance stream binding missing");
        if(selected->frequency!=0||selected->offset<0)throw std::runtime_error("Unsupported instance stream frequency/offset");
        if(selected->vb<0||size_t(selected->vb)>=list.vertex_sources.size()||primitive.ib<0||size_t(primitive.ib)>=list.index_sources.size())throw std::runtime_error("Instance resource source index out of bounds");
        const auto& vertex_source=list.vertex_sources[size_t(selected->vb)];
        const auto& index_source=list.index_sources[size_t(primitive.ib)];
        Meta meta;meta.index=instance_index;meta.base=instance.primitive_index;meta.primitive=&primitive;meta.selected=selected;meta.position=position;meta.uv=uv;
        meta.source={int32_t(instance_index),vertex_source.block,vertex_source.index,index_source.block,index_source.index};
        meta.in_scope=target_by_block.count(vertex_source.block)&&target_by_block.count(index_source.block);
        if(!all_instances&&!meta.in_scope)throw std::runtime_error("Instance VB/IB do not bind the selected geometry block");
        if(instance_index>=list.instance_bounds.size())throw std::runtime_error("Archived instance bounds unavailable");
        meta.archived=list.instance_bounds[instance_index];
        std::string matrix_error;
        if(!nodes.world_matrix(list,instance,primitive,meta.matrix,matrix_error,&meta.row)){
            if(meta.in_scope||!all_instances)throw std::runtime_error(matrix_error);
            meta.row=std::numeric_limits<int32_t>::min()+int32_t(instance_index);
        }
        sources.push_back(meta.source);
        metas.push_back(meta);
    }

    // Grouping key: contiguous instances with a byte-identical archived CullNode
    // record and the same resolved constant transform row. In Stage A the block
    // pair coincided with this key; Stage B deliberately drops block equality so
    // a placed object whose draws bind two chunks (26 and 32) stays one group.
    std::vector<Group> groups;
    if(all_instances){
        for(size_t i=0;i<metas.size();i++){
            const auto& meta=metas[i];
            const bool same=!groups.empty()&&groups.back().row==meta.row&&
                std::memcmp(groups.back().archived.data(),meta.archived.data(),sizeof(float)*8)==0;
            if(!same){Group group;group.first=i;group.row=meta.row;group.archived=meta.archived;groups.push_back(group);}
            ++groups.back().count;
            if(meta.in_scope)++groups.back().in_scope;
        }
    }else{
        Group group;group.first=0;group.count=1;group.in_scope=metas[0].in_scope?1:0;
        group.row=metas[0].row;group.archived=metas[0].archived;groups.push_back(group);
    }

    std::vector<float> positions,uvs;std::vector<uint32_t> indices;std::vector<Proof> proofs;
    size_t omitted=0,unsupported=0,incomplete_instances=0,incomplete_groups=0;
    double maximum_error=0;

    auto expand_instance=[&](const Meta& meta,Proof& proof){
        const auto& primitive=*meta.primitive;
        const auto vb_target=target_by_block.at(meta.source.vbBlock);
        const auto ib_target=target_by_block.at(meta.source.ibBlock);
        const auto& vb_chunk=targets[vb_target];
        const auto& ib_chunk=targets[ib_target];
        if(meta.source.vbIndex<0||meta.source.ibIndex<0||
            size_t(meta.source.vbIndex)>=vb_chunk.vbs.size()||size_t(meta.source.ibIndex)>=ib_chunk.ibs.size())
            throw std::runtime_error("Instance geometry resource index out of bounds");
        const auto& vb=vb_chunk.vbs[size_t(meta.source.vbIndex)];
        const auto& ib=ib_chunk.ibs[size_t(meta.source.ibIndex)];
        if(vb.stride==0||meta.selected->offset%vb.stride)throw std::runtime_error("Unaligned instance vertex stream offset");
        const uint32_t vertex_shift=uint32_t(meta.selected->offset)/vb.stride;
        const Element* stored=nullptr;
        for(const auto& element:vb.elements)if(element.usage==0&&element.index==0){if(stored)throw std::runtime_error("Duplicate position semantic");stored=&element;}
        if(!stored||stored->type!=meta.position->value.type||stored->method!=meta.position->value.method||stored->offset!=meta.position->value.offset)throw std::runtime_error("Instance POSITION0 declaration does not match bound vertex format");
        if(stored->type!=6&&stored->type!=9)throw std::runtime_error("Unsupported instance position vertex format");
        if(uint32_t(stored->offset)+(stored->type==9?8u:12u)>vb.stride)throw std::runtime_error("Instance position exceeds vertex stride");
        // UV0 is exported only when the base primitive declaration, the selected
        // stream and the bound vertex format all agree on one F16_2 (type 8)
        // semantic. Anything else stays explicitly unavailable; no value is inferred.
        const Element* uv_stored=nullptr;bool uv_ok=false;std::string uv_reason;
        if(!meta.uv)uv_reason="No UV0 declaration on instance base primitive";
        else if(meta.uv->value.method!=0||meta.uv->value.type!=8)uv_reason="Unsupported instance UV0 declaration type/method";
        else if(meta.uv->stream!=meta.position->stream)uv_reason="UV0 is declared in a separate vertex stream; not merged";
        else{
            for(const auto& element:vb.elements)if(element.usage==5&&element.index==0){if(uv_stored)throw std::runtime_error("Duplicate UV0 semantic");uv_stored=&element;}
            if(!uv_stored)uv_reason="UV0 declaration has no bound vertex-buffer element";
            else if(uv_stored->type!=meta.uv->value.type||uv_stored->method!=meta.uv->value.method||uv_stored->offset!=meta.uv->value.offset)throw std::runtime_error("Instance UV0 declaration does not match bound vertex format");
            else if(uint32_t(uv_stored->offset)+4u>vb.stride)throw std::runtime_error("Instance UV0 exceeds vertex stride");
            else uv_ok=true;
        }
        proof.uv_type=meta.uv?meta.uv->value.type:-1;proof.uv_offset=meta.uv?int32_t(meta.uv->value.offset):-1;proof.uv_stride=int32_t(vb.stride);
        if(primitive.lods.empty())throw std::runtime_error("Instance base primitive has no LOD0");
        const auto& lod=primitive.lods[0];
        if(lod.offset>ib.count||lod.count>ib.count-lod.offset||lod.min>vb.count||lod.vertices>vb.count-lod.min||vertex_shift>vb.count)throw std::runtime_error("Instance primitive range exceeds buffer");
        if(primitive.topology!=0&&primitive.topology!=1)throw std::runtime_error("Unsupported instance primitive topology");
        if(primitive.topology==0&&lod.count%3)throw std::runtime_error("Invalid instance triangle-list index count");

        std::vector<uint32_t> source_indices;
        for(uint32_t j=0;j<lod.count;j++){
            const size_t at=ib.data+size_t(lod.offset+j)*ib.width;
            const uint32_t index=ib.width==2?(uint32_t(ib_chunk.data[at])|uint32_t(ib_chunk.data[at+1])<<8):(uint32_t(ib_chunk.data[at])|uint32_t(ib_chunk.data[at+1])<<8|uint32_t(ib_chunk.data[at+2])<<16|uint32_t(ib_chunk.data[at+3])<<24);
            if(index<lod.min||index>=lod.min+lod.vertices||index+vertex_shift>=vb.count)throw std::runtime_error("Instance index outside primitive vertex range");
            source_indices.push_back(index);
        }
        std::vector<uint32_t> triangles;const uint32_t step=primitive.topology==0?3u:1u;
        for(size_t j=2;j<source_indices.size();j+=step){
            uint32_t a=source_indices[j-2],b=source_indices[j-1],c=source_indices[j];
            if(primitive.topology==1&&j%2)std::swap(a,b);
            if(a==b||b==c||a==c)continue;
            triangles.insert(triangles.end(),{a,b,c});
        }
        if(triangles.empty())throw std::runtime_error("Instance produced no nondegenerate triangles");

        std::vector<uint32_t> used=source_indices;std::sort(used.begin(),used.end());used.erase(std::unique(used.begin(),used.end()),used.end());
        const uint32_t base_vertex=uint32_t(positions.size()/3);
        std::map<uint32_t,uint32_t> compact;std::vector<double> instance_world;
        std::vector<float> instance_uvs;instance_uvs.reserve(used.size()*2);
        for(size_t i=0;i<used.size();i++){
            const uint32_t vertex=used[i]+vertex_shift;
            if(vertex>=vb.count)throw std::runtime_error("Instance vertex outside bound buffer");
            const size_t at=vb.data+size_t(vertex)*vb.stride+stored->offset;
            double x,y,z;
            if(stored->type==6){
                float fx,fy,fz;std::memcpy(&fx,&vb_chunk.data[at],4);std::memcpy(&fy,&vb_chunk.data[at+4],4);std::memcpy(&fz,&vb_chunk.data[at+8],4);x=fx;y=fy;z=fz;
            }else{
                const auto bits=[&](size_t offset){return uint16_t(vb_chunk.data[at+offset])|uint16_t(vb_chunk.data[at+offset+1])<<8;};
                x=half(bits(0));y=half(bits(2));z=half(bits(4));
            }
            if(!std::isfinite(x)||!std::isfinite(y)||!std::isfinite(z))throw std::runtime_error("Nonfinite instance position");
            for(int a=0;a<3;a++){
                const double value=x*meta.matrix[size_t(a)]+y*meta.matrix[size_t(4+a)]+z*meta.matrix[size_t(8+a)]+meta.matrix[size_t(12+a)];
                if(!std::isfinite(value))throw std::runtime_error("Nonfinite transformed instance position");
                instance_world.push_back(value);positions.push_back(float(value));
            }
            if(uv_ok){
                const size_t uv_at=vb.data+size_t(vertex)*vb.stride+size_t(uv_stored->offset);
                const auto uv_bits=[&](size_t offset){return uint16_t(vb_chunk.data[uv_at+offset])|uint16_t(vb_chunk.data[uv_at+offset+1])<<8;};
                const uint16_t hu=uv_bits(0),hv=uv_bits(2);
                if(((hu>>10)&31)==31||((hv>>10)&31)==31){uv_ok=false;uv_reason="Nonfinite instance UV0";}
                else{const float u=half(hu),v=half(hv);instance_uvs.push_back(u);instance_uvs.push_back(v);}
            }
            compact[used[i]]=base_vertex+uint32_t(i);
        }
        if(!uv_ok)instance_uvs.assign(used.size()*2,0.0f);
        uvs.insert(uvs.end(),instance_uvs.begin(),instance_uvs.end());
        proof.index=int32_t(meta.index);proof.base=meta.base;proof.vbBlock=meta.source.vbBlock;proof.ibBlock=meta.source.ibBlock;
        proof.matrix=meta.matrix;proof.first=uint32_t(indices.size());
        proof.low={INFINITY,INFINITY,INFINITY};proof.high={-INFINITY,-INFINITY,-INFINITY};
        for(size_t i=0;i<instance_world.size();i++){proof.low[i%3]=std::min(proof.low[i%3],instance_world[i]);proof.high[i%3]=std::max(proof.high[i%3],instance_world[i]);}
        for(const auto v:triangles)indices.push_back(compact.at(v));
        proof.count=uint32_t(indices.size())-proof.first;
        proof.vertexCount=uint32_t(used.size());
        proof.uv_available=uv_ok;proof.uv_reason=uv_ok?std::string():uv_reason;
        if(uv_ok){proof.uv_hash=uv_range_hash(uvs,indices,proof.first,proof.count);proof.uv_hashed=true;}
        Draw material_draw;material_draw.uv_available=proof.uv_available;
        nodes.bind_albedo(primitive,material_draw,true);
        proof.albedo_index=material_draw.albedo;
        proof.albedo_parameter=material_draw.albedo_parameter;
        proof.resource_block=material_draw.resource_block;proof.resource_index=material_draw.resource_index;
        proof.material_row=material_draw.material_row;proof.material=material_draw.material;
        proof.binding=material_draw.binding;
        if(proof.albedo_index>=0){
            proof.binding_status=proof.uv_available?"static-shared-albedo-resolved":"blocked";
            if(proof.uv_available)proof.binding="g_tAlbedo static shared image resolved through the ordered instance/base/stream material stack";
            else proof.binding_reason=material_draw.binding;
        }else if(proof.resource_block>=0&&proof.resource_index>=0){
            proof.binding_status=proof.uv_available?"static-resource-albedo-resolved":"blocked";
            if(proof.uv_available)proof.binding="g_tAlbedo static resource texture identity resolved; texture name, format, alpha, blend and sampler state are not applied by this reader";
            else proof.binding_reason=material_draw.binding;
        }else{
            proof.binding_status="blocked";proof.binding_reason=material_draw.binding;
        }
    };

    for(auto& group:groups){
        if(all_instances&&group.in_scope!=group.count){
            if(group.in_scope==0){omitted+=group.count;group.status="other-block";continue;}
            ++incomplete_groups;incomplete_instances+=group.in_scope;omitted+=group.count-group.in_scope;
            group.status="incomplete";continue;
        }
        const size_t saved_positions=positions.size(),saved_indices=indices.size(),saved_proofs=proofs.size();
        std::array<double,3> low{INFINITY,INFINITY,INFINITY},high{-INFINITY,-INFINITY,-INFINITY};
        for(size_t i=group.first;i<group.first+group.count;i++){
            Proof proof;expand_instance(metas[i],proof);
            for(int a=0;a<3;a++){
                low[size_t(a)]=std::min(low[size_t(a)],proof.low[size_t(a)]);
                high[size_t(a)]=std::max(high[size_t(a)],proof.high[size_t(a)]);
            }
            proofs.push_back(std::move(proof));
        }
        double error=0;
        for(int a=0;a<3;a++){
            error=std::max(error,std::abs(low[size_t(a)]-double(group.archived[size_t(a)])));
            error=std::max(error,std::abs(high[size_t(a)]-double(group.archived[size_t(a+3)])));
        }
        group.low=low;group.high=high;group.error=error;
        if(all_instances){
            if(error>0.0001){
                positions.resize(saved_positions);indices.resize(saved_indices);proofs.resize(saved_proofs);
                unsupported+=group.count;group.status="unsupported";
            }else{
                for(size_t k=saved_proofs;k<proofs.size();k++)proofs[k].error=error;
                maximum_error=std::max(maximum_error,error);group.status="emitted";
            }
        }else{
            if(error>0.0001)throw std::runtime_error("Transformed instance geometry disagrees with archived bounds at instance "+std::to_string(metas[0].index)+" error "+std::to_string(error));
            proofs[0].error=error;maximum_error=error;group.status="emitted";
        }
    }

    std::vector<int32_t> required_blocks;
    for(const auto& source:sources){required_blocks.push_back(source.vbBlock);required_blocks.push_back(source.ibBlock);}
    std::sort(required_blocks.begin(),required_blocks.end());required_blocks.erase(std::unique(required_blocks.begin(),required_blocks.end()),required_blocks.end());
    std::vector<int32_t> unsupplied_blocks;
    for(const auto block:required_blocks)if(!target_by_block.count(block))unsupplied_blocks.push_back(block);

    auto write_geometry_meta=[&](std::ostringstream& out){
        if(bundled){
            out<<",\"bundledGeometry\":true,\"geometryBlocks\":[";
            for(size_t k=0;k<targets.size();k++){if(k)out<<',';out<<targets[k].block;}
            out<<"],\"geometryChunks\":[";
            for(size_t k=0;k<targets.size();k++){
                if(k)out<<',';const auto& target=targets[k];
                out<<"{\"block\":"<<target.block<<",\"chunkIndex\":"<<target.chunk_index<<",\"itemIndex\":"<<target.item_index<<",\"streamOffset\":"<<target.stream_offset<<'}';
            }
            out<<']';
        }else{
            out<<",\"geometryChunkIndex\":"<<targets[0].chunk_index<<",\"geometryItemIndex\":"<<targets[0].item_index
               <<",\"geometryStreamOffset\":"<<targets[0].stream_offset;
        }
    };
    auto write_group_meta=[&](std::ostringstream& out){
        if(all_instances){
            out<<",\"incompleteBoundsGroups\":"<<incomplete_groups<<",\"incompleteBoundsGroupInstances\":"<<incomplete_instances;
            out<<",\"unsuppliedGeometryBlocks\":[";for(size_t i=0;i<unsupplied_blocks.size();i++){if(i)out<<',';out<<unsupplied_blocks[i];}
            out<<"],\"boundsGroupDetails\":[";
            for(size_t gi=0;gi<groups.size();gi++){
                if(gi)out<<',';const auto& group=groups[gi];
                out<<"{\"firstInstance\":"<<group.first<<",\"instanceCount\":"<<group.count<<",\"inScopeInstanceCount\":"<<group.in_scope
                   <<",\"transformConstantRow\":"<<group.row<<",\"archivedBounds\":[";
                for(int k=0;k<8;k++){if(k)out<<',';out<<group.archived[size_t(k)];}
                out<<"],\"unionBounds\":";
                if(std::string(group.status)=="emitted"||std::string(group.status)=="unsupported"){
                    out<<"{\"min\":["<<group.low[0]<<','<<group.low[1]<<','<<group.low[2]<<"],\"max\":["<<group.high[0]<<','<<group.high[1]<<','<<group.high[2]<<"]},";
                }else out<<"null,";
                out<<"\"maxAbsoluteDifference\":"<<group.error<<",\"status\":\""<<group.status<<"\"}";
            }
            out<<']';
        }
    };

    if(proofs.empty()){
        if(!all_instances)throw std::runtime_error("No supported instance binds the selected geometry block; omittedOtherBlock="+std::to_string(omitted)+" unsupportedBounds="+std::to_string(unsupported));
        std::ostringstream out;out.imbue(std::locale::classic());
        out<<"{\"status\":\"ok\",\"positions\":[],\"indices\":[],\"uv0\":[],\"draws\":[],\"bounds\":{\"min\":[0,0,0],\"max\":[0,0,0]},\"metadata\":{\"instancesApplied\":true,\"nodeTransformsApplied\":true,\"coordinateSpace\":\"world\",\"instanceIndex\":0,\"instanceCount\":"<<list.instances.size()
           <<",\"emittedInstanceCount\":0,\"omittedOtherBlockInstances\":"<<omitted<<",\"unsupportedBoundsInstances\":"<<unsupported
           <<",\"vertexCount\":0,\"triangleCount\":0,\"uv0Exported\":true,\"uv0Values\":0,\"uv0Bytes\":0,\"uv0AvailableDraws\":0,\"uv0HashedDraws\":0,\"uv0ValidVertices\":0,\"uv0PlaceholderVertices\":0"
           <<",\"boundsMaxAbsoluteDifference\":0,\"boundsAvailable\":false,\"boundsGrouping\":"
           <<(bundled?"\"contiguous instances sharing an identical archived CullNode bounds record and resolved constant transform row; member geometry is resolved from the supplied chunks by VB/IB block and a group with any unsupplied member is withheld\"":"\"contiguous instances sharing an identical archived CullNode bounds record and resolved constant transform row; member draw AABB union compared to the shared record\"")
           <<",\"boundsGroups\":"<<(all_instances?groups.size():size_t(0));
        if(!bundled)out<<",\"geometryBlock\":"<<targets[0].block;
        out<<",\"nodeBlock\":"<<node_block;
        write_geometry_meta(out);
        out<<",\"nodeChunkIndex\":"<<node_chunk_index<<",\"requiredGeometryBlocks\":[";
        for(size_t i=0;i<required_blocks.size();i++){if(i)out<<',';out<<required_blocks[i];}
        out<<']';write_group_meta(out);
        out<<",\"instanceSources\":[";for(size_t i=0;i<sources.size();i++){if(i)out<<',';const auto&s=sources[i];out<<"{\"instanceIndex\":"<<s.index<<",\"vertexBlock\":"<<s.vbBlock<<",\"vertexIndex\":"<<s.vbIndex<<",\"indexBlock\":"<<s.ibBlock<<",\"indexIndex\":"<<s.ibIndex<<'}';}
        out<<"],\"integrityValidated\":false,\"material\":\"static-albedo-identity-only\",\"materialAlbedoResolved\":true,\"materialColourApplied\":false,\"blendStateApplied\":false,\"alphaRuleApplied\":false,\"shaderStagesApplied\":false,\"samplerStateApplied\":false,\"scope\":\"no instance bound to the supplied geometry chunk(s) passed the grouped constant affine bounds check; static g_tAlbedo identity only, alpha/blend/shader/sampler not applied\"}}";
        return out.str();
    }

    std::array<double,3> world_min{INFINITY,INFINITY,INFINITY},world_max{-INFINITY,-INFINITY,-INFINITY};
    for(const auto& proof:proofs)for(int a=0;a<3;a++){world_min[size_t(a)]=std::min(world_min[size_t(a)],proof.low[size_t(a)]);world_max[size_t(a)]=std::max(world_max[size_t(a)],proof.high[size_t(a)]);}

    size_t uv_valid_vertices=0,uv_available_draws=0,uv_hashed_draws=0;
    for(const auto& proof:proofs){if(proof.uv_available){++uv_available_draws;uv_valid_vertices+=proof.vertexCount;}if(proof.uv_hashed)++uv_hashed_draws;}
    const size_t uv_placeholder_vertices=positions.size()/3-uv_valid_vertices;

    std::ostringstream out;out.imbue(std::locale::classic());out<<std::setprecision(std::numeric_limits<float>::max_digits10);
    out<<"{\"status\":\"ok\",\"positions\":[";for(size_t i=0;i<positions.size();i++){if(i)out<<',';out<<positions[i];}
    out<<"],\"indices\":[";for(size_t i=0;i<indices.size();i++){if(i)out<<',';out<<indices[i];}
    out<<"],\"uv0\":[";for(size_t i=0;i<uvs.size();i++){if(i)out<<',';out<<uvs[i];}
    out<<"],\"draws\":[";
    const auto write_nullable_string=[&](const std::string& value){if(value.empty())out<<"null";else out<<'"'<<escape(value.c_str())<<'"';};
    for(size_t i=0;i<proofs.size();i++){if(i)out<<',';const auto&p=proofs[i];
        out<<"{\"firstIndex\":"<<p.first<<",\"indexCount\":"<<p.count<<",\"albedoTexture\":";
        if(p.albedo_index<0)out<<"null";else out<<p.albedo_index;
        out<<",\"binding\":\""<<escape(p.binding.c_str())<<"\",\"uv0Available\":"<<(p.uv_available?"true":"false")<<",\"albedoParameter\":";
        write_nullable_string(p.albedo_parameter);
        out<<",\"resourceBlock\":";if(p.resource_block<0)out<<"null";else out<<p.resource_block;
        out<<",\"resourceIndex\":";if(p.resource_index<0)out<<"null";else out<<p.resource_index;
        out<<",\"instanceIndex\":"<<p.index<<",\"basePrimitiveIndex\":"<<p.base<<",\"material\":";
        write_nullable_string(p.material);
        out<<",\"materialRow\":"<<p.material_row<<",\"albedoTextureId\":";
        if(p.resource_block>=0&&p.resource_index>=0)out<<'"'<<"level.albedo."<<p.resource_block<<'.'<<p.resource_index<<'"';else out<<"null";
        out<<",\"bindingStatus\":\""<<p.binding_status<<"\",\"bindingReason\":";
        write_nullable_string(p.binding_reason);
        out<<",\"uvHash\":";
        if(p.uv_hashed)out<<'"'<<"0x"<<hex16(p.uv_hash)<<'"';else out<<"null";
        out<<",\"uvReason\":";
        write_nullable_string(p.uv_reason);
        out<<",\"uvType\":"<<p.uv_type<<",\"uvOffset\":"<<p.uv_offset<<",\"uvStride\":"<<p.uv_stride<<'}';
    }
    out<<"],\"bounds\":{\"min\":["<<world_min[0]<<','<<world_min[1]<<','<<world_min[2]<<"],\"max\":["<<world_max[0]<<','<<world_max[1]<<','<<world_max[2]<<"]},"
       <<"\"metadata\":{\"instancesApplied\":true,\"nodeTransformsApplied\":true,\"coordinateSpace\":\"world\",\"instanceIndex\":0,\"instanceCount\":"<<list.instances.size()
       <<",\"emittedInstanceCount\":"<<proofs.size()<<",\"omittedOtherBlockInstances\":"<<omitted<<",\"unsupportedBoundsInstances\":"<<unsupported
       <<",\"boundsGrouping\":"<<(bundled?"\"contiguous instances sharing an identical archived CullNode bounds record and resolved constant transform row; member geometry is resolved from the supplied chunks by VB/IB block and a group with any unsupplied member is withheld\"":(all_instances?"\"contiguous instances sharing an identical archived CullNode bounds record and resolved constant transform row; member draw AABB union compared to the shared record\"":"\"none; first instance only\""))<<",\"boundsGroups\":"<<(all_instances?groups.size():size_t(0))
       <<",\"basePrimitiveIndex\":"<<proofs[0].base<<",\"basePrimitiveCount\":"<<list.base_primitives.size()
       <<",\"vertexCount\":"<<positions.size()/3<<",\"triangleCount\":"<<indices.size()/3
       <<",\"uv0Exported\":true,\"uv0Values\":"<<uvs.size()<<",\"uv0Bytes\":"<<uvs.size()*4
       <<",\"uv0AvailableDraws\":"<<uv_available_draws<<",\"uv0HashedDraws\":"<<uv_hashed_draws
       <<",\"uv0ValidVertices\":"<<uv_valid_vertices<<",\"uv0PlaceholderVertices\":"<<uv_placeholder_vertices
       <<",\"uv0Aggregate\":\"0x"<<hex16(uv_stream_hash(uvs))<<"\""
       <<",\"uv0PlaceholderPolicy\":\"zero pairs for unavailable draws; placeholder UVs cannot bind albedo\""
       <<",\"matrix\":[";
    for(int i=0;i<16;i++){if(i)out<<',';out<<proofs[0].matrix[size_t(i)];}
    out<<"],\"matrixSemantics\":\"row vector: out[a]=x*m[a]+y*m[4+a]+z*m[8+a]+m[12+a]\",\"archivedInstanceBounds\":[";
    if(!list.instance_bounds.empty())for(int i=0;i<8;i++){if(i)out<<',';out<<list.instance_bounds[0][size_t(i)];}
    out<<"],\"boundsMaxAbsoluteDifference\":"<<maximum_error;
    if(!bundled)out<<",\"geometryBlock\":"<<targets[0].block;
    out<<",\"nodeBlock\":"<<node_block;
    write_geometry_meta(out);
    out<<",\"nodeChunkIndex\":"<<node_chunk_index<<",\"nodeStreamOffset\":"<<node_record.offset
       <<",\"requiredGeometryBlocks\":[";
    for(size_t i=0;i<required_blocks.size();i++){if(i)out<<',';out<<required_blocks[i];}
    out<<']';write_group_meta(out);
    out<<",\"instanceSources\":[";
    for(size_t i=0;i<sources.size();i++){
        if(i)out<<',';const auto&s=sources[i];
        out<<"{\"instanceIndex\":"<<s.index<<",\"vertexBlock\":"<<s.vbBlock<<",\"vertexIndex\":"<<s.vbIndex<<",\"indexBlock\":"<<s.ibBlock<<",\"indexIndex\":"<<s.ibIndex<<'}';
    }
    out<<"],\"instances\":[";
    for(size_t i=0;i<proofs.size();i++){
        if(i)out<<',';const auto&p=proofs[i];
        out<<"{\"instanceIndex\":"<<p.index<<",\"basePrimitiveIndex\":"<<p.base<<",\"firstIndex\":"<<p.first<<",\"indexCount\":"<<p.count<<",\"vertexBlock\":"<<p.vbBlock<<",\"indexBlock\":"<<p.ibBlock<<",\"matrix\":[";
        for(int k=0;k<16;k++){if(k)out<<',';out<<p.matrix[size_t(k)];}
        out<<"],\"worldBounds\":{\"min\":["<<p.low[0]<<','<<p.low[1]<<','<<p.low[2]<<"],\"max\":["<<p.high[0]<<','<<p.high[1]<<','<<p.high[2]<<"]},\"archivedInstanceBounds\":[";
        for(int k=0;k<8;k++){if(k)out<<',';out<<list.instance_bounds[p.index][size_t(k)];}
        out<<"],\"boundsMaxAbsoluteDifference\":"<<p.error<<'}';
    }
    out<<"],\"integrityValidated\":false,\"material\":\"static-albedo-identity-only\",\"materialAlbedoResolved\":true,\"materialColourApplied\":false,\"blendStateApplied\":false,\"alphaRuleApplied\":false,\"shaderStagesApplied\":false,\"samplerStateApplied\":false,\"scope\":\"";
    if(all_instances)out<<"all instances whose VB/IB bind a supplied geometry block and whose contiguous CullNode group matches its archived bounds; UV0 and the static g_tAlbedo resource identity are exported; texture name/format, alpha, blend, shader stages, sampler state and higher LODs are not applied";
    else out<<"first RenderList instance0, constant affine row-vector world transform, direct LOD0 base primitive; UV0 and the static g_tAlbedo resource identity are exported; other instances, texture format/alpha/blend/shader/sampler and higher LODs omitted";
    out<<"\"}}";
    return out.str();
}
std::string level_instances_impl(const unsigned char* level,size_t level_size,const unsigned char* geometry_bytes,size_t geometry_size,
                                 const unsigned char* node_bytes,size_t node_size,int32_t geometry_block,int32_t node_block,bool all_instances){
    const int32_t blocks[1]={geometry_block};const unsigned char* geometries[1]={geometry_bytes};const size_t sizes[1]={geometry_size};
    return level_instances_core(level,level_size,node_bytes,node_size,blocks,geometries,sizes,1,node_block,all_instances,false);
}
std::string level_instances_bundle(const unsigned char* level,size_t level_size,const unsigned char* node_bytes,size_t node_size,int32_t node_block,
                                   const int32_t* geometry_blocks,const unsigned char* const* geometry_bytes,const size_t* geometry_sizes,size_t geometry_count){
    return level_instances_core(level,level_size,node_bytes,node_size,geometry_blocks,geometry_bytes,geometry_sizes,geometry_count,node_block,true,true);
}
std::string level_instances(const unsigned char* level,size_t level_size,const unsigned char* geometry_bytes,size_t geometry_size,
                            const unsigned char* node_bytes,size_t node_size,int32_t geometry_block,int32_t node_block){
    return level_instances_impl(level,level_size,geometry_bytes,geometry_size,node_bytes,node_size,geometry_block,node_block,false);
}
std::string level_instances_all(const unsigned char* level,size_t level_size,const unsigned char* geometry_bytes,size_t geometry_size,
                                const unsigned char* node_bytes,size_t node_size,int32_t geometry_block,int32_t node_block){
    return level_instances_impl(level,level_size,geometry_bytes,geometry_size,node_bytes,node_size,geometry_block,node_block,true);
}
extern "C" char* scene_inspect(const unsigned char* bytes,size_t available){try{if(!bytes||available<20||available>max_input)throw std::runtime_error("Input outside supported bounds");Decoder d{{bytes,available}};return copy(d.run());}catch(const std::exception& e){return copy("{\"status\":\"error\",\"error\":\""+escape(e.what())+"\"}");}catch(...){return copy("{\"status\":\"error\",\"error\":\"Scene allocation failure\"}");}}
extern "C" char* scene_resource_textures_inspect(const unsigned char* bytes,size_t available){try{return copy(scene_resource_textures(bytes,available));}catch(const std::exception& e){return copy("{\"status\":\"error\",\"error\":\""+escape(e.what())+"\"}");}catch(...){return copy("{\"status\":\"error\",\"error\":\"Resource texture metadata allocation failure\"}");}}
extern "C" char* level_index_inspect(const unsigned char* bytes,size_t available){try{return copy(level_index(bytes,available));}catch(const std::exception& e){return copy("{\"status\":\"error\",\"error\":\""+escape(e.what())+"\"}");}catch(...){return copy("{\"status\":\"error\",\"error\":\"Level index allocation failure\"}");}}
extern "C" char* level_mesh_inspect(const unsigned char* level,size_t level_size,const unsigned char* geometry,size_t geometry_size,const unsigned char* nodes,size_t nodes_size,int32_t geometry_block,int32_t node_block){try{return copy(level_mesh(level,level_size,geometry,geometry_size,nodes,nodes_size,geometry_block,node_block));}catch(const std::exception& e){return copy("{\"status\":\"error\",\"error\":\""+escape(e.what())+"\"}");}catch(...){return copy("{\"status\":\"error\",\"error\":\"Level mesh allocation failure\"}");}}
extern "C" char* level_instances_inspect(const unsigned char* level,size_t level_size,const unsigned char* geometry,size_t geometry_size,const unsigned char* nodes,size_t nodes_size,int32_t geometry_block,int32_t node_block){try{return copy(level_instances(level,level_size,geometry,geometry_size,nodes,nodes_size,geometry_block,node_block));}catch(const std::exception& e){return copy("{\"status\":\"error\",\"error\":\""+escape(e.what())+"\"}");}catch(...){return copy("{\"status\":\"error\",\"error\":\"Level instance allocation failure\"}");}}
extern "C" char* level_instances_all_inspect(const unsigned char* level,size_t level_size,const unsigned char* geometry,size_t geometry_size,const unsigned char* nodes,size_t nodes_size,int32_t geometry_block,int32_t node_block){try{return copy(level_instances_all(level,level_size,geometry,geometry_size,nodes,nodes_size,geometry_block,node_block));}catch(const std::exception& e){return copy("{\"status\":\"error\",\"error\":\""+escape(e.what())+"\"}");}catch(...){return copy("{\"status\":\"error\",\"error\":\"Level instance-all allocation failure\"}");}}
extern "C" EMSCRIPTEN_KEEPALIVE char* level_instances_bundle_inspect(const unsigned char* level,size_t level_size,const unsigned char* nodes,size_t nodes_size,int32_t node_block,const int32_t* geometry_blocks,const unsigned char* const* geometry,const size_t* geometry_sizes,size_t geometry_count){try{return copy(level_instances_bundle(level,level_size,nodes,nodes_size,node_block,geometry_blocks,geometry,geometry_sizes,geometry_count));}catch(const std::exception& e){return copy("{\"status\":\"error\",\"error\":\""+escape(e.what())+"\"}");}catch(...){return copy("{\"status\":\"error\",\"error\":\"Level instance-bundle allocation failure\"}");}}
extern "C" void scene_free(void* pointer){std::free(pointer);}




