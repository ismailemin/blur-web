#include "scene_reader.h"
#include <cstdint>
#include <cstring>
#include <fstream>
#include <iostream>
#include <iterator>
#include <limits>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
using Bytes=std::vector<unsigned char>;
void check(bool value,const char* error){if(!value)throw std::runtime_error(error);}
size_t count_text(const std::string& text,const std::string& needle){size_t count=0,at=0;while((at=text.find(needle,at))!=std::string::npos){++count;at+=needle.size();}return count;}
void byte(Bytes& b,uint8_t n){b.push_back(n);}
void word(Bytes& b,uint16_t n){byte(b,uint8_t(n));byte(b,uint8_t(n>>8));}
void integer(Bytes& b,uint32_t n){for(int i=0;i<4;i++)byte(b,uint8_t(n>>(i*8)));}
void zero(Bytes& b,size_t n){b.insert(b.end(),n,0);}
void marker(Bytes& b,uint16_t version=0){byte(b,'R');byte(b,'A');word(b,version);}
void vector(Bytes& b,uint32_t count=0){marker(b);integer(b,count);}
void string(Bytes& b,const std::string&s){integer(b,uint32_t(s.size()));b.insert(b.end(),s.begin(),s.end());}
void real(Bytes& b,float f){uint32_t v;std::memcpy(&v,&f,4);integer(b,v);}
void platform(Bytes& b){marker(b);integer(b,2);}
void bits(Bytes& b,uint32_t count=0,uint32_t bytes=0){marker(b);integer(b,count);vector(b,bytes);zero(b,bytes);}
void cull(Bytes& b,uint32_t bit_count=0,uint32_t bit_bytes=0){marker(b,2);marker(b);string(b,"");vector(b);zero(b,16);marker(b);zero(b,32);bits(b,bit_count,bit_bytes);integer(b,0xffffffff);bits(b);}
void material(Bytes& b,int32_t index=0,int32_t list=0){marker(b);integer(b,uint32_t(index));integer(b,uint32_t(list));}
void blob(Bytes& b,const Bytes& data){marker(b);integer(b,uint32_t(data.size()));integer(b,1);integer(b,0);byte(b,0);b.insert(b.end(),data.begin(),data.end());}
Bytes chunk(const char* id,const Bytes& data,uint16_t count=0,bool container=false){Bytes b;auto n=std::strlen(id);b.insert(b.end(),id,id+n);zero(b,8-n);integer(b,uint32_t(data.size()+16));word(b,count);byte(b,container?0x43:0x41);byte(b,0);b.insert(b.end(),data.begin(),data.end());return b;}
void append(Bytes& a,const Bytes& b){a.insert(a.end(),b.begin(),b.end());}
struct TestMaterial{int32_t type=7,index=0,list=0;};
struct TestStream{int32_t slot=0,vb=0,offset=0,frequency=0,row=0,list=0;};
struct FixtureOptions{
    bool uv=false,uv_subset=false;int32_t uv_type=5,declared_uv_type=-1,declared_uv_offset=-1,declared_uv_stream=0;
    std::string effect="test.fx",parameter="g_tAlbedo";
    std::vector<TestMaterial> rows{{}};std::vector<TestStream> streams;
    int32_t base_row=0,instance_row=0;uint32_t shared_textures=1;
};
Bytes fixture(uint32_t vertex_byte_offset=0,uint16_t last_index=2,bool nonfinite=false,uint32_t albedo_index=0,int32_t source_block=0,uint32_t bit_count=0,uint32_t bit_bytes=0,bool half_positions=false,bool auxiliary_streams=false,uint32_t auxiliary_frequency=0,const FixtureOptions& opts=FixtureOptions{}){
    Bytes s;for(const char c:std::string("ARCH"))byte(s,c);integer(s,1);integer(s,0);for(const char c:std::string("ARCH"))byte(s,c);integer(s,0);integer(s,1);
    marker(s,1);platform(s);marker(s);string(s,"");marker(s);cull(s,bit_count,bit_bytes);
    const uint16_t uv_offset=half_positions?8:12;
    const uint32_t buffer_count=opts.uv_subset?2:1;
    vector(s,buffer_count);for(uint32_t i=0;i<buffer_count;i++){
        const bool with_uv=opts.uv&&i==0;marker(s);integer(s,with_uv?2:1);marker(s);word(s,0);word(s,0);integer(s,half_positions?9:6);integer(s,0);integer(s,0);byte(s,0);
        if(with_uv){marker(s);word(s,uint16_t(opts.declared_uv_stream));word(s,opts.declared_uv_offset<0?uv_offset:uint16_t(opts.declared_uv_offset));integer(s,uint32_t(opts.declared_uv_type<0?opts.uv_type:opts.declared_uv_type));integer(s,0);integer(s,5);byte(s,0);}
    }
    vector(s,1);marker(s);marker(s);string(s,opts.effect);integer(s,1);marker(s);platform(s);integer(s,opts.shared_textures);
    for(uint32_t i=0;i<opts.shared_textures;i++){string(s,"test_albedo");integer(s,0);marker(s);platform(s);string(s,"test_albedo");marker(s,1);zero(s,40);integer(s,0);integer(s,0);}
    marker(s);marker(s,3);for(int i=0;i<5;i++)vector(s);integer(s,0);vector(s);integer(s,1);
    marker(s);platform(s);integer(s,1);marker(s);platform(s);integer(s,0);
    vector(s,buffer_count);for(uint32_t b=0;b<buffer_count;b++){
    const bool with_uv=opts.uv&&b==0;const uint32_t uv_bytes=opts.uv_type==8?4:8;
    byte(s,2);marker(s,1);marker(s);integer(s,uv_offset+(with_uv?uv_bytes:0));vector(s,with_uv?2:1);marker(s);integer(s,half_positions?9:6);zero(s,12);
    if(with_uv){marker(s);integer(s,uint32_t(opts.uv_type));integer(s,0);integer(s,5);integer(s,0);}
    vector(s,with_uv?2:1);word(s,0);if(with_uv)word(s,uv_offset);integer(s,6);
    Bytes vb;for(int i=0;i<6;i++){
        if(half_positions){const uint16_t encoded[]={0,0x3c00,0x4000,0x4200,0x4400,0x4500};word(vb,nonfinite&&i==0?0x7c00:encoded[i]);word(vb,i%2?0x3c00:0);word(vb,0);word(vb,0);}
        else{real(vb,nonfinite&&i==0?std::numeric_limits<float>::quiet_NaN():float(i));real(vb,float(i%2));real(vb,0);}
        if(with_uv){if(opts.uv_type==5){real(vb,float(i)/2);real(vb,-float(i));}else{word(vb,0x3800);word(vb,0xbc00);if(opts.uv_type==9){word(vb,0x7c00);word(vb,0x7c00);}}}
    }blob(s,vb);}
    vector(s,1);byte(s,2);marker(s,1);integer(s,3);integer(s,0);Bytes ib;word(ib,0);word(ib,1);word(ib,last_index);blob(s,ib);
    vector(s,1);byte(s,3);string(s,"RenderingData::RenderListNode_Common");marker(s);marker(s,4);cull(s);
    marker(s);vector(s,uint32_t(opts.rows.size()));for(const auto& row:opts.rows){marker(s);string(s,"test_material");vector(s,1);marker(s);string(s,row.type==8?"nestedMaterial":opts.parameter);integer(s,uint32_t(row.type));integer(s,1);integer(s,row.type==8||row.type==9?8:4);integer(s,4);vector(s,1);word(s,0);zero(s,8);}zero(s,8);
    vector(s,buffer_count);for(uint32_t b=0;b<buffer_count;b++){
    marker(s,1);integer(s,0);integer(s,b);integer(s,0);integer(s,0);integer(s,0);material(s,opts.base_row);material(s,opts.instance_row);marker(s);zero(s,24);
    vector(s,1);marker(s);integer(s,0);integer(s,3);integer(s,0);integer(s,3);
    const auto stream=[&](int32_t index,int32_t vb_index,int32_t offset,int32_t frequency,int32_t row=0,int32_t list=0){marker(s);integer(s,uint32_t(vb_index));integer(s,uint32_t(index));integer(s,uint32_t(offset));integer(s,uint32_t(frequency));material(s,row,list);};
    vector(s,opts.streams.empty()?(auxiliary_streams?3:1):uint32_t(opts.streams.size()));
    if(!opts.streams.empty()){for(const auto& st:opts.streams)stream(st.slot,st.vb,st.offset,st.frequency,st.row,st.list);}
    else{if(auxiliary_streams)stream(3,1,0,int32_t(auxiliary_frequency));stream(0,int32_t(b),int32_t(vertex_byte_offset),0);if(auxiliary_streams)stream(1,1,0,0);}}
    vector(s);vector(s);vector(s);integer(s,uint32_t(opts.rows.size()));integer(s,4*uint32_t(opts.rows.size()));for(size_t i=0;i<opts.rows.size();i++){const auto& row=opts.rows[i];integer(s,uint32_t(i));if(row.type==8||row.type==9)material(s,row.index,row.list);else integer(s,i==0&&opts.rows.size()==1?albedo_index:uint32_t(row.index));}
    vector(s);for(int k=0;k<3;k++)vector(s);
    for(int k=0;k<3;k++){marker(s,1);integer(s,0);vector(s);integer(s,0);vector(s);}
    vector(s);vector(s);vector(s);
    for(int k=0;k<2;k++){const auto count=k==1?(opts.uv_subset?2:(auxiliary_streams||!opts.streams.empty()?2:1)):1;vector(s,uint32_t(count));integer(s,uint32_t(source_block));integer(s,0);if(count==2){integer(s,opts.uv_subset?uint32_t(source_block):0xffffffff);integer(s,opts.uv_subset?1:0xffffffff);}}
    vector(s,opts.shared_textures);for(uint32_t i=0;i<opts.shared_textures;i++){integer(s,0xffffffff);integer(s,i);}vector(s);
    integer(s,0); // ResourceBlock LOD0 texture count (raw U32); no synthetic textures.
    Bytes header;integer(header,0);Bytes inner;append(inner,chunk("Header",header));append(inner,chunk("Scene",s));Bytes outer=chunk("Render",chunk("Render",inner,2,true));Bytes model=chunk("Model",outer,1,true);Bytes all{' ',' ','C','P'};append(all,model);return all;
}
std::string inspect(const unsigned char* data,size_t n){auto*j=scene_inspect(data,n);check(j!=nullptr,"Allocation failed");std::string s(j);scene_free(j);return s;}
std::string inspect_resources(const unsigned char* data,size_t n){auto*j=scene_resource_textures_inspect(data,n);check(j!=nullptr,"Allocation failed");std::string s(j);scene_free(j);return s;}
bool ok(const std::string&s){return s.find("\"status\":\"ok\"")!=std::string::npos;}
bool has(const std::string&s,const char* p){return s.find(p)!=std::string::npos;}
bool has(const std::string&s,const std::string&p){return s.find(p)!=std::string::npos;}
std::vector<std::string> draw_objects(const std::string& s){
    std::vector<std::string> result;auto p=s.find("\"draws\":[");check(p!=std::string::npos,"Missing draws");p+=9;
    while(p<s.size()&&s[p]!=']'){if(s[p]==',')++p;const auto end=s.find('}',p);check(end!=std::string::npos,"Unterminated draw");result.push_back(s.substr(p,end-p+1));p=end+1;}return result;
}
std::string configured(const FixtureOptions& opts){const auto b=fixture(0,2,false,0,0,0,0,false,false,0,opts);return inspect(b.data(),b.size());}
void material_and_uv_tests(){
    FixtureOptions opts;opts.uv=true;auto result=configured(opts);check(ok(result),result.c_str());
    check(has(result,"\"uv0\":[0,-0,0.5,-1,1,-2,1.5,-3,2,-4,2.5,-5]"),"Original float UVs changed");
    check(has(result,"\"uv0Available\":true,\"albedoParameter\":\"g_tAlbedo\""),"Declared prop UV binding absent");
    opts.uv_type=9;result=configured(opts);check(ok(result)&&has(result,"\"uv0\":[0.5,-1,0.5,-1"),"F16_4 UV .xy decoding failed or unused .zw interpreted");
    opts.declared_uv_type=8;check(!ok(configured(opts)),"Mismatched UV declaration type accepted");opts.declared_uv_type=-1;
    opts.declared_uv_offset=8;check(!ok(configured(opts)),"Mismatched UV declaration offset accepted");opts.declared_uv_offset=-1;
    opts.declared_uv_stream=3;result=configured(opts);check(ok(result)&&has(result,"\"uv0Available\":false")&&has(result,"\"albedoTexture\":null"),"Unmerged separate UV stream claimed original mapping");opts.declared_uv_stream=0;
    opts=FixtureOptions{};opts.uv=true;opts.uv_subset=true;result=configured(opts);check(ok(result),result.c_str());auto draws=draw_objects(result);
    check(draws.size()==2&&has(draws[0],"\"albedoTexture\":0")&&has(draws[0],"\"uv0Available\":true")&&has(draws[1],"\"albedoTexture\":null")&&has(draws[1],"\"uv0Available\":false"),"One missing UV buffer disabled valid subset or became textured");
    check(has(result,"\"uv0ValidVertices\":6,\"uv0PlaceholderVertices\":6")&&has(result,"\"uv0\":[0,-0,0.5,-1,1,-2,1.5,-3,2,-4,2.5,-5,0,0,0,0,0,0,0,0,0,0,0,0]"),"UV subset values or bounded placeholder counts wrong");
    opts=FixtureOptions{};opts.uv=true;opts.shared_textures=2;opts.rows={{7,0,0},{7,1,0}};
    // Missing auxiliary VB (-1,-1) still applies its material after the POSITION stream.
    opts.streams={{0,0,0,0,0,0},{3,1,0,0,1,0}};result=configured(opts);check(ok(result)&&has(result,"\"albedoTexture\":1"),"Later zero-size auxiliary stream material ignored");
    opts.streams={{3,1,0,0,1,0},{0,0,0,0,0,0}};result=configured(opts);check(ok(result)&&has(result,"\"albedoTexture\":0"),"Serialized stream material order ignored");
    opts.streams={{0,0,0,0,0,0},{-1,1,0,0,1,0}};result=configured(opts);check(ok(result)&&has(result,"\"albedoTexture\":0"),"Disabled stream material was applied");
    opts.streams={{0,0,0,0,0,0},{3,1,0,0,0,1}};result=configured(opts);check(ok(result)&&has(result,"\"albedoTexture\":null")&&has(result,"rebuilt at runtime"),"Later unknown runtime material retained stale albedo");
    opts.streams={{3,1,0,0,0,1},{0,0,0,0,1,0}};result=configured(opts);check(ok(result)&&has(result,"\"albedoTexture\":1"),"Later static material did not resolve earlier unknown runtime assignment");
    opts.streams={{0,0,0,0,0,0}};opts.rows={{8,1,0},{7,1,0}};result=configured(opts);check(ok(result)&&has(result,"\"albedoTexture\":1"),"Nested constant MATERIAL_INDEX not followed");
    opts.rows={{8,0,0},{7,1,0}};check(!ok(configured(opts)),"Recursive constant MATERIAL_INDEX accepted");
    opts.rows={{9,1,1},{7,1,0}};result=configured(opts);check(ok(result)&&has(result,"\"albedoTexture\":null")&&has(result,"runtime material data"),"DATA_INDEX invented a static texture");
    opts.rows={{7,0,0},{7,1,0}};opts.parameter="g_MeshTexture";opts.effect="veh_Default.fx";result=configured(opts);check(ok(result)&&has(result,"\"albedoParameter\":\"g_MeshTexture\""),"Original vehicle texture parameter unsupported");
    opts.effect="veh_Paint_a_b_c.fx";result=configured(opts);check(ok(result)&&has(result,"\"albedoTexture\":null")&&has(result,"runtime paint lookup"),"_a flag guessed as paint albedo");
    opts.effect="veh_Light.fx";result=configured(opts);check(ok(result)&&has(result,"\"albedoTexture\":null")&&has(result,"Off/On blend"),"Runtime light blend flattened to one albedo");
}
std::string index_level(const unsigned char* data,size_t n){char* p=level_index_inspect(data,n);check(p!=nullptr,"Null level index output");std::string out(p);scene_free(p);return out;}
std::string inspect_level(const Bytes& level,const Bytes& geometry,const Bytes& nodes,int32_t geo_block=252,int32_t node_block=253){
    char* p=level_mesh_inspect(level.data(),level.size(),geometry.data(),geometry.size(),nodes.data(),nodes.size(),geo_block,node_block);
    check(p!=nullptr,"Null level mesh output");std::string out(p);scene_free(p);return out;
}
Bytes read_file(const char* path){std::ifstream file(path,std::ios::binary);check(bool(file),"Real level fixture file missing");return Bytes((std::istreambuf_iterator<char>(file)),{});}
void set32(Bytes& b,size_t p,uint32_t value){check(p+4<=b.size(),"Test mutation outside fixture");for(unsigned i=0;i<4;i++)b[p+i]=uint8_t(value>>(i*8));}
void real_level_tests(const char* level_path,const char* geometry_path,const char* node_path){
    auto level=read_file(level_path),geometry=read_file(geometry_path),nodes=read_file(node_path);
    auto index=index_level(level.data(),level.size());check(ok(index),index.c_str());check(has(index,"\"resourceBlockCount\":1227"),"River Scene block count changed");
    check(has(index,"\"offset\":68937728,\"storedBytes\":10240"),"River ChunkInfo range changed");
    const auto result=inspect_level(level,geometry,nodes);check(ok(result),result.c_str());
    check(has(result,"\"vertexCount\":344")&&has(result,"\"triangleCount\":208")&&has(result,"\"primitiveCount\":5"),"Actual streamed level geometry count wrong");
    check(has(result,"\"instancesApplied\":false")&&has(result,"\"instanceDescriptionsSkipped\":57")&&has(result,"\"instanceBasePrimitivesSkipped\":36"),"Level instance scope misrepresented");
    check(has(result,"\"firstIndex\":0,\"indexCount\":90")&&has(result,"\"firstIndex\":570,\"indexCount\":54"),"Actual level draw boundaries changed");
    check(!ok(inspect_level(level,geometry,nodes,-1,253)),"Negative level geometry block accepted");
    check(!ok(inspect_level(level,geometry,nodes,252,1227)),"Out-of-range level node block accepted");
    check(!ok(inspect_level(level,geometry,nodes,252,252)),"Same node/geometry block accepted");
    check(!ok(inspect_level(level,nodes,geometry)),"Swapped stream ranges accepted");
    auto shorter=geometry;shorter.pop_back();check(!ok(inspect_level(level,shorter,nodes)),"Truncated geometry range accepted");
    shorter=nodes;shorter.pop_back();check(!ok(inspect_level(level,geometry,shorter)),"Truncated node range accepted");
    check(!ok(index_level(level.data(),level.size()-1)),"Truncated level FileBlock accepted");
    auto bad_level=level;bad_level[0]='X';check(!ok(index_level(bad_level.data(),bad_level.size())),"Wrong level platform accepted");
    bad_level=level;set32(bad_level,40,3);check(!ok(index_level(bad_level.data(),bad_level.size())),"EffectVariation string outside Header accepted");
    auto bad_geometry=geometry;set32(bad_geometry,20,7);check(!ok(inspect_level(level,bad_geometry,nodes)),"Chunk item count mismatch accepted");
    bad_geometry=geometry;set32(bad_geometry,192,0x7fc00000);check(!ok(inspect_level(level,bad_geometry,nodes)),"Nonfinite real level vertex accepted");
    bad_geometry=geometry;bad_geometry[8496]=255;bad_geometry[8497]=255;check(!ok(inspect_level(level,bad_geometry,nodes)),"Real level out-of-range index accepted");
    auto bad_nodes=nodes;set32(bad_nodes,1574,0xffffffff);check(!ok(inspect_level(level,geometry,bad_nodes)),"Unbounded level primitive count accepted");
    bad_nodes=nodes;set32(bad_nodes,21829,0xffffffff);check(!ok(inspect_level(level,geometry,bad_nodes)),"Unbounded level source vector accepted");
    bad_nodes=nodes;set32(bad_nodes,21833,251);check(!ok(inspect_level(level,geometry,bad_nodes)),"Wrong level vertex source block accepted");
    bad_nodes=nodes;set32(bad_nodes,21769,251);check(!ok(inspect_level(level,geometry,bad_nodes)),"Wrong level index source block accepted");
    check(result==inspect_level(level,geometry,nodes),"Level output is nondeterministic");
    std::cout<<"Actual river Scene index, 344 vertices/208 triangles/5 draws, explicit instance scope and malformed stream/binding checks passed\n";
}
void real_instance_tests(const char* level_path,const char* geometry_path,const char* node_path){    const auto level=read_file(level_path),geometry=read_file(geometry_path),node=read_file(node_path);
    auto* raw=level_instances_inspect(level.data(),level.size(),geometry.data(),geometry.size(),node.data(),node.size(),27,253);
    check(raw!=nullptr,"Allocation failed");std::string result(raw);scene_free(raw);
    check(ok(result),result.c_str());
    check(has(result,"\"vertexCount\":805,\"triangleCount\":726"),"Instance vertex/triangle counts changed");
    check(has(result,"\"instanceCount\":57")&&has(result,"\"basePrimitiveIndex\":0"),"Instance/base association changed");
    check(has(result,"\"instancesApplied\":true")&&has(result,"\"coordinateSpace\":\"world\""),"Instance transform scope missing");
    check(has(result,"\"geometryBlock\":27,\"nodeBlock\":253"),"Instance geometry/node block IDs changed");
    check(has(result,"\"boundsMaxAbsoluteDifference\":3.86511"),"Instance archived-bounds agreement changed");
    check(has(result,"\"matrixSemantics\":\"row vector: out[a]=x*m[a]+y*m[4+a]+z*m[8+a]+m[12+a]\""),"Instance matrix semantics missing");
    auto* repeat_raw=level_instances_inspect(level.data(),level.size(),geometry.data(),geometry.size(),node.data(),node.size(),27,253);
    check(repeat_raw!=nullptr,"Allocation failed");std::string repeat(repeat_raw);scene_free(repeat_raw);
    check(result==repeat,"Instance JSON nondeterministic");
    auto* all_raw=level_instances_all_inspect(level.data(),level.size(),geometry.data(),geometry.size(),node.data(),node.size(),27,253);
    check(all_raw!=nullptr,"Allocation failed");std::string all(all_raw);scene_free(all_raw);
    check(ok(all),all.c_str());
    check(has(all,"\"emittedInstanceCount\":22")&&has(all,"\"omittedOtherBlockInstances\":35")&&has(all,"\"unsupportedBoundsInstances\":0"),"All-instance block27 counts changed");
    check(has(all,"\"vertexCount\":13162,\"triangleCount\":10308"),"All-instance block27 geometry counts changed");
    check(has(all,"\"uv0Exported\":true,\"uv0Values\":26324,\"uv0Bytes\":105296"),"Instance UV0 stream size changed");
    check(has(all,"\"uv0AvailableDraws\":22,\"uv0HashedDraws\":22,\"uv0ValidVertices\":13162,\"uv0PlaceholderVertices\":0"),"Instance UV0 availability counts changed");
    check(has(all,"\"uv0Aggregate\":\"0xb07310e198de4c19\""),"Instance UV0 stream aggregate changed");
    check(count_text(all,"\"uv0Available\":true")==22&&count_text(all,"\"uvHash\":\"0x")==22,"Instance draw UV0 coverage changed");
    check(count_text(all,"\"bindingStatus\":\"static-resource-albedo-resolved\"")==22,"Instance static albedo identity coverage changed");
    check(count_text(all,"\"albedoTextureId\":\"level.albedo.")==22,"Instance albedo texture identity coverage changed");
    check(has(all,"\"instanceIndex\":0,\"basePrimitiveIndex\":0,\"material\":\"default_LN_NB_NL_NV.fx\",\"materialRow\":9,\"albedoTextureId\":\"level.albedo.1073.0\",\"bindingStatus\":\"static-resource-albedo-resolved\",\"bindingReason\":null,\"uvHash\":\"0xefa29d38b989ce85\""),"Instance0 UV/material binding changed");
    check(has(all,"\"uvType\":8,\"uvOffset\":16,\"uvStride\":20"),"Instance0 UV0 source layout changed");
    check(all.find("\"uv0Available\":false")==std::string::npos,"A block27 instance draw lost its source UV0");
    check(has(all,"\"boundsMaxAbsoluteDifference\":6.02443715e-05"),"All-instance bounds agreement changed");
    std::cout<<"Actual River block27/node253 instance0: 805 vertices/726 triangles, archived bounds 3.86511e-05 passed\n";
    std::cout<<"Block27 all supported instances: 22 emitted/0 unsupported/35 other-block, 13162 vertices/10308 triangles passed\n";
    check(has(all,"\"boundsGroups\":34"),"All-instance group count changed");
}
size_t find_nth(const Bytes& haystack,const Bytes& needle,size_t nth){
    if(needle.empty()||needle.size()>haystack.size())return std::string::npos;
    size_t found=0;
    for(size_t i=0;i+needle.size()<=haystack.size();i++)
        if(std::memcmp(haystack.data()+i,needle.data(),needle.size())==0&&++found==nth)return i;
    return std::string::npos;
}
void real_instance_bundle_tests(const char* level_path,const char* node_path,const char* block15_path,const char* block17_path,
                                const char* block26_path,const char* block27_path,const char* block32_path){
    const auto level=read_file(level_path),node=read_file(node_path);
    const auto b15=read_file(block15_path),b17=read_file(block17_path),b26=read_file(block26_path),
               b27=read_file(block27_path),b32=read_file(block32_path);
    const int32_t blocks[5]={15,17,26,27,32};
    const unsigned char* pointers[5]={b15.data(),b17.data(),b26.data(),b27.data(),b32.data()};
    const size_t sizes[5]={b15.size(),b17.size(),b26.size(),b27.size(),b32.size()};
    auto raw=level_instances_bundle_inspect(level.data(),level.size(),node.data(),node.size(),253,blocks,pointers,sizes,5);
    check(raw!=nullptr,"Bundle allocation failed");std::string all(raw);scene_free(raw);
    check(ok(all),all.c_str());
    check(has(all,"\"emittedInstanceCount\":56")&&has(all,"\"omittedOtherBlockInstances\":1")&&has(all,"\"unsupportedBoundsInstances\":0"),"Bundle instance counts changed");
    check(has(all,"\"incompleteBoundsGroups\":0")&&has(all,"\"incompleteBoundsGroupInstances\":0"),"Complete bundle reported an incomplete group");
    check(has(all,"\"vertexCount\":34632,\"triangleCount\":25521"),"Bundle geometry counts changed");
    check(has(all,"\"boundsGroups\":34"),"Bundle group count changed");
    check(has(all,"\"geometryBlocks\":[15,17,26,27,32]"),"Bundle block list changed");
    check(has(all,"\"unsuppliedGeometryBlocks\":[31]"),"Block31 prerequisite is not reported as unsupplied");
    check(has(all,"\"boundsMaxAbsoluteDifference\":6.02443715e-05"),"Bundle group union error changed");
    check(has(all,"\"firstInstance\":33,\"instanceCount\":3,\"inScopeInstanceCount\":3"),"Cross-chunk group 43 membership changed");
    auto repeat_raw=level_instances_bundle_inspect(level.data(),level.size(),node.data(),node.size(),253,blocks,pointers,sizes,5);
    check(repeat_raw!=nullptr,"Bundle allocation failed");std::string repeat(repeat_raw);scene_free(repeat_raw);
    check(all==repeat,"Bundle JSON nondeterministic");

    const int32_t only26[1]={26};const unsigned char* only26_ptr[1]={b26.data()};const size_t only26_size[1]={b26.size()};
    auto partial_raw=level_instances_bundle_inspect(level.data(),level.size(),node.data(),node.size(),253,only26,only26_ptr,only26_size,1);
    check(partial_raw!=nullptr,"Partial bundle allocation failed");std::string partial(partial_raw);scene_free(partial_raw);
    check(ok(partial),partial.c_str());
    check(has(partial,"\"emittedInstanceCount\":0")&&has(partial,"\"incompleteBoundsGroupInstances\":10")&&has(partial,"\"incompleteBoundsGroups\":6")&&has(partial,"\"omittedOtherBlockInstances\":47"),"Partial group was not withheld as a whole");
    check(has(partial,"\"vertexCount\":0,\"triangleCount\":0"),"Partial group emitted geometry");

    const int32_t duplicate[2]={26,26};const unsigned char* duplicate_ptr[2]={b26.data(),b26.data()};const size_t duplicate_size[2]={b26.size(),b26.size()};
    auto duplicate_raw=level_instances_bundle_inspect(level.data(),level.size(),node.data(),node.size(),253,duplicate,duplicate_ptr,duplicate_size,2);
    check(duplicate_raw!=nullptr,"Duplicate bundle allocation failed");std::string duplicate_json(duplicate_raw);scene_free(duplicate_raw);
    check(!ok(duplicate_json)&&has(duplicate_json,"Duplicate geometry block"),"Duplicate geometry block accepted");

    Bytes truncated(b26.begin(),b26.end()-1);
    const unsigned char* truncated_ptr[1]={truncated.data()};const size_t truncated_size[1]={truncated.size()};
    auto truncated_raw=level_instances_bundle_inspect(level.data(),level.size(),node.data(),node.size(),253,only26,truncated_ptr,truncated_size,1);
    check(truncated_raw!=nullptr,"Truncated bundle allocation failed");std::string truncated_json(truncated_raw);scene_free(truncated_raw);
    check(!ok(truncated_json)&&has(truncated_json,"length differs"),"Truncated geometry chunk accepted");

    const int32_t cross[2]={26,32};
    const unsigned char* wrong_ptr[2]={b32.data(),b32.data()};const size_t wrong_size[2]={b32.size(),b32.size()};
    auto wrong_raw=level_instances_bundle_inspect(level.data(),level.size(),node.data(),node.size(),253,cross,wrong_ptr,wrong_size,2);
    check(wrong_raw!=nullptr,"Wrong-chunk allocation failed");std::string wrong_json(wrong_raw);scene_free(wrong_raw);
    check(!ok(wrong_json)&&has(wrong_json,"length differs"),"Swapped geometry chunk accepted");

    Bytes corrupt=b26;corrupt[0]='X';
    const unsigned char* corrupt_ptr[1]={corrupt.data()};const size_t corrupt_size[1]={corrupt.size()};
    auto corrupt_raw=level_instances_bundle_inspect(level.data(),level.size(),node.data(),node.size(),253,only26,corrupt_ptr,corrupt_size,1);
    check(corrupt_raw!=nullptr,"Corrupt bundle allocation failed");std::string corrupt_json(corrupt_raw);scene_free(corrupt_raw);
    check(!ok(corrupt_json)&&has(corrupt_json,"signature"),"Corrupt stream signature accepted");

    // One ULP in one member's archived CullNode record must split the group and
    // reject all three members; a byte-identity merge would emit 20 instances.
    const unsigned char record35[32]={0x6b,0xa3,0xc8,0xc2,0xbe,0x74,0xb6,0x40,0x71,0xa0,0x82,0x44,0x22,0xe2,0xa0,0xc2,
                                      0xd7,0x56,0x23,0x41,0xff,0x2a,0x83,0x44,0x00,0x00,0xc0,0x42,0x00,0x00,0x7a,0x43};
    const Bytes needle(record35,record35+sizeof(record35));
    const size_t at=find_nth(node,needle,3);
    check(at!=std::string::npos,"Instance35 archived record occurrence missing");
    Bytes perturbed_node=node;perturbed_node[at+12]=static_cast<unsigned char>(perturbed_node[at+12]^0x01);
    const unsigned char* cross_ptr[2]={b26.data(),b32.data()};const size_t cross_size[2]={b26.size(),b32.size()};
    auto perturbed_raw=level_instances_bundle_inspect(level.data(),level.size(),perturbed_node.data(),perturbed_node.size(),253,cross,cross_ptr,cross_size,2);
    check(perturbed_raw!=nullptr,"Perturbed bundle allocation failed");std::string perturbed(perturbed_raw);scene_free(perturbed_raw);
    check(ok(perturbed),perturbed.c_str());
    check(has(perturbed,"\"emittedInstanceCount\":17")&&has(perturbed,"\"unsupportedBoundsInstances\":3"),"One-byte record change did not reject the whole group");
    std::cout<<"River bundle blocks15/17/26/27/32: 56 instances/34632 vertices/25521 triangles, 34 groups, error 6.02444e-05 passed\n";
    std::cout<<"Partial block26 bundle withholds 10 instances as 6 incomplete groups; malformed/truncated/duplicate/one-byte record cases rejected passed\n";
}

void real_car_tests(const char* path){
    const auto input=read_file(path);const auto result=inspect(input.data(),input.size());check(ok(result),result.c_str());
    check(has(result,"\"vertexCount\":30591")&&has(result,"\"triangleCount\":36193")&&has(result,"\"primitiveCount\":80"),"Original Corvette geometry changed");
    check(has(result,"\"uv0ValidVertices\":17955,\"uv0PlaceholderVertices\":12636"),"Original Corvette UV subset counts changed");
    check(has(result,"\"runtimePaintColourRecovered\":false,\"runtimePaintTextureRecovered\":false"),"Unrecovered paint state misrepresented");
    const auto draws=draw_objects(result);check(draws.size()==80,"Original Corvette draw count changed");
    int expected[80];for(auto& v:expected)v=-1;
    for(int i:{11,12,13,14})expected[i]=6;for(int i:{22,23})expected[i]=2;
    for(int i:{36,39,40,43})expected[i]=3;for(int i:{37,38,41,42})expected[i]=5;
    size_t bound=0;bool textures[7]{};
    for(size_t i=0;i<draws.size();i++){const auto fragment=std::string("\"albedoTexture\":")+(expected[i]<0?"null":std::to_string(expected[i]));check(draws[i].find(fragment)!=std::string::npos,"Corvette draw differs from independent source-material report");
        if(expected[i]>=0){++bound;textures[expected[i]]=true;check(has(draws[i],"\"uv0Available\":true,\"albedoParameter\":\"g_MeshTexture\""),"Corvette albedo lacks original vehicle UV binding");}}
    check(bound==14&&textures[2]&&textures[3]&&textures[5]&&textures[6],"Corvette shared texture draw set changed");
    check(has(draws[0],"runtime paint lookup")&&has(draws[6],"Original resource-block texture input"),"Corvette unsupported paint/external texture identity lost");
    size_t resource=0;
    for(int i:{6,15,16,17,18,19,20,21,61,65,66,79}){const int block=(i==21||i==79)?2:6;
        check(has(draws[size_t(i)],"\"resourceBlock\":"+std::to_string(block))&&has(draws[size_t(i)],"\"resourceIndex\":0")&&has(draws[size_t(i)],"\"albedoTexture\":null"),"Corvette resource texture identity differs from source-material report");++resource;}
    check(resource==12,"Corvette resource texture draw count changed");
    const auto resources=inspect_resources(input.data(),input.size());check(ok(resources),resources.c_str());
    check(has(resources,"\"name\":\"corvetterace_dials\"")&&has(resources,"\"payloadOffset\":2051185,\"payloadBytes\":368"),"Dials LOD0 descriptor/payload span changed");
    check(has(resources,"\"name\":\"corvetterace_interior\"")&&has(resources,"\"payloadOffset\":2950577,\"payloadBytes\":184"),"Interior LOD0 descriptor/payload span changed");
    check(has(resources,"\"parsedUntilOffset\":3125977"),"Resource block traversal did not end at the Scene boundary");
    check(resources==inspect_resources(input.data(),input.size()),"Resource texture JSON nondeterministic");
    check(result==inspect(input.data(),input.size()),"Corvette JSON nondeterministic");
    std::cout<<"Actual Corvette 30591 vertices/36193 triangles/80 draws, 17955 valid UVs and 14 original shared-albedo draws passed\n";
}
}
int main(int argc,char**argv){try{
    check(!ok(inspect(nullptr,0)),"Null accepted");unsigned char tiny[4]={' ',' ','C','P'};check(!ok(inspect(tiny,std::numeric_limits<size_t>::max())),"Oversize accepted");scene_free(nullptr);
    check(!ok(index_level(nullptr,0)),"Null level index accepted");check(!ok(index_level(tiny,std::numeric_limits<size_t>::max())),"Oversize level index accepted");
    char* invalid_level=level_mesh_inspect(tiny,std::numeric_limits<size_t>::max(),tiny,4,tiny,4,252,253);check(invalid_level!=nullptr,"Null level API error");check(!ok(invalid_level),"Oversize level mesh accepted");scene_free(invalid_level);
    char* invalid_bundle=level_instances_bundle_inspect(tiny,4,tiny,4,253,nullptr,nullptr,nullptr,0);check(invalid_bundle!=nullptr,"Null bundle API error");check(!ok(invalid_bundle),"Null/empty bundle accepted");scene_free(invalid_bundle);
    if(argc==5&&std::strcmp(argv[1],"--level")==0){real_level_tests(argv[2],argv[3],argv[4]);return 0;}
    if(argc==5&&std::strcmp(argv[1],"--instances")==0){real_instance_tests(argv[2],argv[3],argv[4]);return 0;}
    if(argc==9&&std::strcmp(argv[1],"--instances-bundle")==0){real_instance_bundle_tests(argv[2],argv[3],argv[4],argv[5],argv[6],argv[7],argv[8]);return 0;}
    if(argc==3&&std::strcmp(argv[1],"--car")==0){real_car_tests(argv[2]);return 0;}
    material_and_uv_tests();
    const auto input=fixture();auto output=inspect(input.data(),input.size());check(ok(output),output.c_str());check(has(output,"\"indices\":[0,1,2]"),"Triangle list changed");check(has(output,"\"fixtureOnly\":false"),"Generic parser mislabelled");check(has(output,"\"partialSceneTraversal\":true"),"Partial scope missing");check(has(output,"\"firstIndex\":0,\"indexCount\":3,\"albedoTexture\":null")&&has(output,"\"uv0Available\":false"),"Missing original UV0 became a source albedo mapping");
    const auto resource_output=inspect_resources(input.data(),input.size());check(ok(resource_output),resource_output.c_str());check(has(resource_output,"\"resourceBlockCount\":1")&&has(resource_output,"\"loadedResourceBlocks\":1"),"Synthetic resource block metadata traversal failed");
    for(size_t size=0;size<input.size();size++)check(!ok(inspect(input.data(),size)),"Truncated fixture accepted");
    auto shifted=fixture(36);check(has(inspect(shifted.data(),shifted.size()),"\"indices\":[3,4,5]"),"Byte stream offset interpreted as vertices");
    auto unaligned=fixture(1);check(!ok(inspect(unaligned.data(),unaligned.size())),"Unaligned stream offset accepted");
    auto bad_index=fixture(0,6);check(!ok(inspect(bad_index.data(),bad_index.size())),"Out of bounds index accepted");
    auto nan=fixture(0,2,true);check(!ok(inspect(nan.data(),nan.size())),"Nonfinite position accepted");
    auto half_input=fixture(0,2,false,0,0,0,0,true);auto half_output=inspect(half_input.data(),half_input.size());check(ok(half_output),half_output.c_str());check(has(half_output,"\"positions\":[0,0,0,1,1,0,2,0,0,3,1,0,4,0,0,5,1,0]"),"F16_4 positions or forced W interpretation wrong");
    auto half_inf=fixture(0,2,true,0,0,0,0,true);check(!ok(inspect(half_inf.data(),half_inf.size())),"Nonfinite half position accepted");
    auto auxiliary=fixture(0,2,false,0,0,0,0,true,true);auto auxiliary_output=inspect(auxiliary.data(),auxiliary.size());check(ok(auxiliary_output),auxiliary_output.c_str());check(has(auxiliary_output,"\"indices\":[0,1,2]"),"Selected first auxiliary stream instead of declared POSITION stream");
    auto instanced=fixture(0,2,false,0,0,0,0,true,true,1);check(!ok(inspect(instanced.data(),instanced.size())),"Instanced auxiliary data silently accepted");
    auto bad_texture=fixture(0,2,false,7);auto missing=inspect(bad_texture.data(),bad_texture.size());check(ok(missing)&&has(missing,"\"albedoTexture\":null")&&has(missing,"Node texture index out of bounds"),"Invalid material texture became a binding");
    auto external=fixture(0,2,false,0,1);check(!ok(inspect(external.data(),external.size())),"External buffer was silently interpreted as local");
    auto nonempty_bits=fixture(0,2,false,0,0,512,64);check(ok(inspect(nonempty_bits.data(),nonempty_bits.size())),"Byte-based bit vector rejected");
    auto reserved_bits=fixture(0,2,false,0,0,9,4);check(ok(inspect(reserved_bits.data(),reserved_bits.size())),"Reserved bit vector bytes rejected");
    auto short_bits=fixture(0,2,false,0,0,9,1);check(!ok(inspect(short_bits.data(),short_bits.size())),"Insufficient bit vector storage accepted");
    auto altered=input;altered[0]='X';check(!ok(inspect(altered.data(),altered.size())),"Wrong platform accepted");
    check(output==inspect(input.data(),input.size()),"Nondeterministic result");
    if(argc>1){std::ifstream f(argv[1],std::ios::binary);Bytes real_input((std::istreambuf_iterator<char>(f)),{});auto result=inspect(real_input.data(),real_input.size());check(ok(result),result.c_str());check(has(result,"\"vertexCount\":100"),"Actual vertex count wrong");check(has(result,"\"triangleCount\":114"),"Actual strips wrong");check(has(result,"\"parsedUntilOffset\":6968"),"Actual traversal wrong");check(has(result,"\"firstIndex\":0,\"indexCount\":30,\"albedoTexture\":0"),"First source material binding wrong");check(has(result,"\"firstIndex\":30,\"indexCount\":312,\"albedoTexture\":0"),"Second source material binding wrong");}
    std::cout<<"Scene source-format fixture, every truncation, byte offsets, invalid geometry and optional actual fixture passed\n";return 0;
}catch(const std::exception&e){std::cerr<<e.what()<<'\n';return 1;}}
