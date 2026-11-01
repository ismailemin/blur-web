#include "mesh_reader.h"
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <iomanip>
#include <limits>
#include <locale>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
constexpr size_t kFixtureSize = 8015;
constexpr char kFixtureHash[] = "57f28fb4026a638c2a93469148b8597ebf93ac79c22acd3c836d58e32fc1565b";

// FIPS 180-4 SHA-256, used as an identity gate, not an authenticity claim.
uint32_t rotate(uint32_t value, unsigned bits) {
    return (value >> bits) | (value << (32 - bits));
}
std::string sha256(const unsigned char* bytes, size_t length) {
    constexpr uint32_t constants[64] = {
        0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
        0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
        0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
        0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
        0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
        0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
        0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
        0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
    };
    uint32_t state[8] = {0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19};
    const size_t padded = ((length + 9 + 63) / 64) * 64;
    for (size_t block = 0; block < padded; block += 64) {
        uint32_t words[64] = {};
        for (size_t i = 0; i < 64; ++i) {
            const size_t pos = block + i;
            unsigned char value = 0;
            if (pos < length) value = bytes[pos];
            else if (pos == length) value = 0x80;
            else if (pos >= padded - 8) value = static_cast<unsigned char>((uint64_t(length) * 8) >> ((padded - 1 - pos) * 8));
            words[i / 4] |= uint32_t(value) << (24 - (i % 4) * 8);
        }
        for (size_t i = 16; i < 64; ++i) {
            const uint32_t a = rotate(words[i - 15], 7) ^ rotate(words[i - 15], 18) ^ (words[i - 15] >> 3);
            const uint32_t b = rotate(words[i - 2], 17) ^ rotate(words[i - 2], 19) ^ (words[i - 2] >> 10);
            words[i] = words[i - 16] + a + words[i - 7] + b;
        }
        uint32_t a=state[0],b=state[1],c=state[2],d=state[3],e=state[4],f=state[5],g=state[6],h=state[7];
        for (size_t i = 0; i < 64; ++i) {
            const uint32_t s1 = rotate(e,6) ^ rotate(e,11) ^ rotate(e,25);
            const uint32_t choice = (e & f) ^ (~e & g);
            const uint32_t t1 = h + s1 + choice + constants[i] + words[i];
            const uint32_t s0 = rotate(a,2) ^ rotate(a,13) ^ rotate(a,22);
            const uint32_t majority = (a & b) ^ (a & c) ^ (b & c);
            const uint32_t t2 = s0 + majority;
            h=g; g=f; f=e; e=d+t1; d=c; c=b; b=a; a=t1+t2;
        }
        state[0]+=a; state[1]+=b; state[2]+=c; state[3]+=d; state[4]+=e; state[5]+=f; state[6]+=g; state[7]+=h;
    }
    std::ostringstream output;
    output.imbue(std::locale::classic());
    output << std::hex << std::setfill('0');
    for (uint32_t word : state) output << std::setw(8) << word;
    return output.str();
}

struct Reader {
    const unsigned char* bytes;
    size_t length;
    size_t cursor = 0;
    void require(size_t offset, size_t count) const {
        if (offset > length || count > length - offset) throw std::runtime_error("Truncated render data");
    }
    uint32_t u32(size_t offset) const {
        require(offset,4);
        return uint32_t(bytes[offset]) | uint32_t(bytes[offset+1])<<8 | uint32_t(bytes[offset+2])<<16 | uint32_t(bytes[offset+3])<<24;
    }
    uint16_t u16(size_t offset) const {
        require(offset,2);
        return uint16_t(bytes[offset]) | uint16_t(bytes[offset+1])<<8;
    }
    uint32_t next32() { const uint32_t result=u32(cursor); cursor+=4; return result; }
    void expect32(uint32_t expected) { if (next32()!=expected) throw std::runtime_error("Unsupported serialized render field"); }
    void archive(uint16_t version) {
        require(cursor,4);
        if (bytes[cursor]!='R' || bytes[cursor+1]!='A' || u16(cursor+2)!=version)
            throw std::runtime_error("Unsupported archive object version");
        cursor+=4;
    }
    void literal(size_t offset, const char* expected, size_t count) const {
        require(offset,count);
        if (std::memcmp(bytes+offset,expected,count)!=0) throw std::runtime_error("Unsupported render chunk layout");
    }
    void chunk(size_t offset, const char* name, uint32_t size, uint16_t count, unsigned char type) const {
        require(offset,16);
        const size_t name_length=std::strlen(name);
        literal(offset,name,name_length);
        for (size_t i=name_length;i<8;++i) if(bytes[offset+i]) throw std::runtime_error("Invalid chunk identifier padding");
        if(u32(offset+8)!=size || u16(offset+12)!=count || bytes[offset+14]!=type || bytes[offset+15]!=0)
            throw std::runtime_error("Unsupported render chunk header");
        require(offset,size);
    }
    size_t buffer(uint32_t expected_size, size_t scene_origin) {
        archive(0);
        expect32(expected_size);
        const uint32_t alignment=next32();
        if(alignment!=16) throw std::runtime_error("Unsupported buffer alignment");
        expect32(0); // Arch::CompressionType::NO_COMPRESSION.
        require(cursor,1);
        if(bytes[cursor++]!=0) throw std::runtime_error("Unsupported buffer endian swap");
        if(cursor<scene_origin) throw std::runtime_error("Invalid archive origin");
        cursor+= (alignment-(cursor-scene_origin)%alignment)%alignment;
        require(cursor,expected_size);
        const size_t result=cursor;
        cursor+=expected_size;
        return result;
    }
    float f32(size_t offset) const {
        static_assert(sizeof(float)==4 && std::numeric_limits<float>::is_iec559,"IEEE754 F32 required");
        const uint32_t bits=u32(offset);
        float value;
        std::memcpy(&value,&bits,4);
        if(!std::isfinite(value)) throw std::runtime_error("Nonfinite mesh position");
        return value;
    }
};

struct Strip { uint32_t offset,count,min_index,vertex_count; };
Strip primitive(Reader& reader,size_t object_offset,size_t lod_offset) {
    reader.cursor=object_offset;
    reader.archive(1);
    reader.expect32(0); // effect
    reader.expect32(0); // vertex declaration
    reader.expect32(1); // RenderingData::TRIANGLE_STRIP
    reader.expect32(0); // index buffer
    reader.expect32(0); // flags
    reader.cursor=lod_offset-8;
    reader.archive(0); // BtlVector<Lod>
    reader.expect32(1);
    reader.archive(0); // Primitive::Lod
    Strip result{reader.next32(),reader.next32(),reader.next32(),reader.next32()};
    reader.archive(0); // BtlVector<PrimitiveStream>
    reader.expect32(1);
    reader.archive(0); // PrimitiveStream
    reader.expect32(0); // vertexBuffer
    reader.expect32(0); // streamIndex
    reader.expect32(0); // vertexOffset
    return result;
}

std::string inspect(const unsigned char* bytes,size_t length) {
    if(!bytes) throw std::runtime_error("Null model input");
    if(length!=kFixtureSize) throw std::runtime_error("Unsupported model: decoder currently requires the 8015-byte trafficcylinder fixture");
    if(sha256(bytes,length)!=kFixtureHash) throw std::runtime_error("Unsupported model: trafficcylinder SHA256 identity does not match");
    Reader reader{bytes,length};
    reader.literal(0,"  CP",4);
    reader.chunk(4,"Model",7676,4,0x43);
    reader.chunk(650,"Render",6510,0,0x41);
    reader.chunk(666,"Render",6494,2,0x43);
    reader.chunk(682,"Header",20,0,0x41);
    if(reader.u32(698)!=0) throw std::runtime_error("Unsupported Render header version");
    reader.chunk(702,"Scene",6458,0,0x41);
    constexpr size_t scene_origin=718;
    reader.literal(718,"ARCH",4);
    if(reader.u32(722)!=1 || reader.u32(726)!=0) throw std::runtime_error("Unsupported archive wrapper");
    reader.literal(730,"ARCH",4);
    if(reader.u32(734)!=0 || reader.u32(738)!=1) throw std::runtime_error("Unsupported Scene archive version");

    // This offset is profile-specific: a generic Scene/resource/node graph
    // traversal is not implemented. SHA256 above prevents matching other files.
    reader.cursor=2731;
    reader.archive(1); // Target::VertexBuffer
    reader.archive(0); // VertexFormat
    const uint32_t stride=reader.next32();
    if(stride!=20) throw std::runtime_error("Unsupported vertex stride");
    reader.archive(0); // BtlVector<VertexElement>
    reader.expect32(3);
    const uint32_t types[3]={6,11,8}; // F32_3, U8_4N, F16_2.
    const uint32_t usages[3]={0,3,5}; // POSITION, NORMAL, TEXCOORD.
    for(size_t i=0;i<3;++i) {
        reader.archive(0);
        reader.expect32(types[i]); reader.expect32(0); reader.expect32(usages[i]); reader.expect32(0);
    }
    reader.archive(0); // BtlVector<U16> element offsets
    reader.expect32(3);
    const uint16_t offsets[3]={0,12,16};
    for(uint16_t expected:offsets) { if(reader.u16(reader.cursor)!=expected) throw std::runtime_error("Unsupported vertex element offset"); reader.cursor+=2; }
    const uint32_t vertex_count=reader.next32();
    if(vertex_count!=100) throw std::runtime_error("Unsupported vertex count");
    const size_t vertices=reader.buffer(vertex_count*stride,scene_origin);
    // Resource vector and pointer tag between vertex and index buffers.
    reader.archive(0);
    reader.expect32(1);
    reader.require(reader.cursor,1);
    if(bytes[reader.cursor++]!=2) throw std::runtime_error("Unsupported index buffer pointer type");
    reader.archive(1); // Target::IndexBuffer
    const uint32_t index_count=reader.next32();
    if(index_count!=202) throw std::runtime_error("Unsupported index count");
    reader.expect32(0); // U16
    const size_t indices=reader.buffer(index_count*2,scene_origin);
    std::array<Strip,2> strips{primitive(reader,6094,6178),primitive(reader,6238,6322)};
    if(strips[0].offset!=179 || strips[0].count!=23 || strips[0].min_index!=84 || strips[0].vertex_count!=16 ||
       strips[1].offset!=0 || strips[1].count!=179 || strips[1].min_index!=0 || strips[1].vertex_count!=84)
        throw std::runtime_error("Unsupported primitive ranges");

    std::vector<float> positions;
    positions.reserve(vertex_count*3);
    std::array<float,3> lower{std::numeric_limits<float>::max(),std::numeric_limits<float>::max(),std::numeric_limits<float>::max()};
    std::array<float,3> upper{std::numeric_limits<float>::lowest(),std::numeric_limits<float>::lowest(),std::numeric_limits<float>::lowest()};
    for(uint32_t vertex=0;vertex<vertex_count;++vertex) for(size_t axis=0;axis<3;++axis) {
        const float value=reader.f32(vertices+vertex*stride+axis*4);
        positions.push_back(value);
        if(value<lower[axis]) lower[axis]=value;
        if(value>upper[axis]) upper[axis]=value;
    }
    std::vector<uint32_t> triangles;
    uint32_t degenerates=0;
    for(const Strip& strip:strips) {
        if(strip.offset>index_count || strip.count>index_count-strip.offset || strip.min_index>vertex_count || strip.vertex_count>vertex_count-strip.min_index)
            throw std::runtime_error("Primitive range exceeds buffer");
        std::vector<uint32_t> values;
        values.reserve(strip.count);
        for(uint32_t i=0;i<strip.count;++i) {
            const uint32_t value=reader.u16(indices+(strip.offset+i)*2);
            if(value<strip.min_index || value>=strip.min_index+strip.vertex_count) throw std::runtime_error("Index outside primitive vertex range");
            values.push_back(value);
        }
        for(uint32_t i=2;i<strip.count;++i) {
            uint32_t a=values[i-2],b=values[i-1],c=values[i];
            // Strip winding alternates even across degenerate connector indices.
            if(i%2) { const uint32_t previous=a; a=b; b=previous; }
            if(a==b || b==c || a==c) { ++degenerates; continue; }
            triangles.insert(triangles.end(),{a,b,c});
        }
    }
    std::ostringstream output;
    output.imbue(std::locale::classic());
    output << std::setprecision(std::numeric_limits<float>::max_digits10)
           << "{\"status\":\"ok\",\"positions\":[";
    for(size_t i=0;i<positions.size();++i) { if(i) output<<','; output<<positions[i]; }
    output << "],\"indices\":[";
    for(size_t i=0;i<triangles.size();++i) { if(i) output<<','; output<<triangles[i]; }
    output << "],\"bounds\":{\"min\":["<<lower[0]<<','<<lower[1]<<','<<lower[2]<<"],\"max\":["<<upper[0]<<','<<upper[1]<<','<<upper[2]<<"]},"
           << "\"metadata\":{\"fixtureOnly\":true,\"profile\":\"trafficcylinder-pc-v1\",\"sha256\":\""<<kFixtureHash<<"\","
           << "\"vertexCount\":"<<vertex_count<<",\"sourceIndexCount\":"<<index_count<<",\"triangleCount\":"<<triangles.size()/3
           << ",\"degenerateTriangleCount\":"<<degenerates<<",\"vertexStride\":"<<stride<<",\"vertexDataOffset\":"<<vertices
           << ",\"indexDataOffset\":"<<indices<<",\"coordinateSpace\":\"object-local\",\"nodeTransformsApplied\":false,"
           << "\"material\":\"diagnostic-only\",\"sourceTopology\":\"triangle-strip\",\"outputTopology\":\"triangle-list\","
           << "\"primitiveRanges\":[{\"offset\":179,\"count\":23,\"minIndex\":84,\"vertexCount\":16},{\"offset\":0,\"count\":179,\"minIndex\":0,\"vertexCount\":84}],"
           << "\"limitations\":[\"Exact fixture identity required; generic Scene traversal is not implemented\",\"Node transforms and materials are not decoded\"]}}";
    return output.str();
}
char* allocate(const std::string& text) {
    char* result=static_cast<char*>(std::malloc(text.size()+1));
    if(result) std::memcpy(result,text.c_str(),text.size()+1);
    return result;
}
std::string quote(const char* text) {
    std::string result="\"";
    const char digits[]="0123456789abcdef";
    for(const unsigned char* current=reinterpret_cast<const unsigned char*>(text);*current;++current) {
        if(*current=='"' || *current=='\\') { result+='\\'; result+=static_cast<char>(*current); }
        else if(*current<0x20) { result+="\\u00"; result+=digits[*current>>4]; result+=digits[*current&15]; }
        else result+=static_cast<char>(*current);
    }
    return result+'"';
}
}

extern "C" char* mesh_inspect(const unsigned char* bytes,size_t available) {
    try { return allocate(inspect(bytes,available)); }
    catch(const std::exception& error) {
        return allocate(std::string("{\"status\":\"error\",\"error\":")+quote(error.what())+"}");
    }
    catch(...) { return allocate("{\"status\":\"error\",\"error\":\"Mesh inspection failed\"}"); }
}
extern "C" void mesh_free(void* pointer) { std::free(pointer); }
