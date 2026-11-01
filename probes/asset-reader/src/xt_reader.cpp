#include "xt_reader.h"
#include <algorithm>
#include <array>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <locale>
#include <sstream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace {
constexpr size_t max_input = 64 * 1024 * 1024;
constexpr size_t header_bytes = 72;
constexpr uint32_t max_output = 16 * 1024 * 1024;
const char* const table_names[] = {"types", "bases", "fields", "strings", "refs", "records", "components", "data"};
constexpr uint32_t table_widths[] = {12, 4, 8, 1, 8, 16, 6, 1};
constexpr uint32_t table_limits[] = {4096, 65535, 100000, 4 * 1024 * 1024, 65535, 65535, 100000, uint32_t(max_input)};
struct Blob {uint32_t offset, count;};
struct Type {uint16_t name, fields, bases, behaviour, atom, size;uint32_t base_start=0, field_start=0;};
struct Base {uint16_t type, offset;};
struct Field {uint16_t name, type, offset;uint8_t behaviour, array;};
struct Ref {uint32_t id;uint16_t type, record;};
struct Record {uint32_t ref, components, bytes, strings, component_start=0, data_offset=0;};
struct Component {uint16_t type, count, behaviour;};

std::string quote(const std::string& value) {
    std::string out="\"";
    for(unsigned char c:value) {
        if(c=='"'||c=='\\')out+='\\';
        if(c>=32&&c<127)out+=char(c);
        else out+='?';
    }
    return out+'"';
}
struct Reader {
    const unsigned char* bytes;size_t length;
    void require(size_t at,size_t count) const {if(at>length||count>length-at)throw std::runtime_error("Truncated XT metadata");}
    uint16_t u16(size_t at)const{require(at,2);return uint16_t(uint16_t(bytes[at])|uint16_t(bytes[at+1])<<8);}
    uint32_t u32(size_t at)const{require(at,4);return uint32_t(bytes[at])|uint32_t(bytes[at+1])<<8|uint32_t(bytes[at+2])<<16|uint32_t(bytes[at+3])<<24;}
};

struct Inspector {
    Reader reader;uint32_t version=0;
    std::array<Blob,8> tables{};
    std::vector<unsigned char> strings;
    std::vector<Type> types;
    std::vector<Base> bases;
    std::vector<Field> fields;
    std::vector<Ref> refs;
    std::vector<Record> records;
    std::vector<Component> components;

    [[noreturn]] void fail(const char* message)const{throw std::runtime_error(message);}
    void read_header() {
        if(reader.u32(0)!=0x464c534b)fail("Unsupported FLSK tag/endian (expected little-endian PC KSLF)");
        version=reader.u32(4);
        if(version!=1&&version!=2)fail("Unsupported FLSK version");
        std::vector<std::pair<uint64_t,uint64_t>> regions;
        for(size_t i=0;i<tables.size();i++) {
            const uint32_t offset=reader.u32(8+i*8),count=reader.u32(12+i*8);
            const uint64_t size=uint64_t(count)*table_widths[i];
            if((offset&3)||count>table_limits[i]||offset>reader.length||size>reader.length-offset)
                fail("XT table outside aligned bounds/limits");
            if(size) {
                if(offset<header_bytes)fail("XT table overlaps header");
                regions.push_back({offset,uint64_t(offset)+size});
            }
            tables[i]={offset,count};
        }
        std::sort(regions.begin(),regions.end());
        for(size_t i=1;i<regions.size();i++)if(regions[i-1].second>regions[i].first)fail("XT tables overlap");
    }
    void read_tables() {
        const auto& st=tables[3];
        strings.assign(reader.bytes+st.offset,reader.bytes+st.offset+st.count);
        if(version==2&&!strings.empty()) {
            uint8_t previous=0xcc;
            for(size_t i=0;i+1<strings.size();i++) {
                const uint8_t value=uint8_t(previous-(strings[i]^0xb3));
                strings[i]=value;
                previous=uint8_t(previous+value-uint32_t(i));
            }
            strings.back()=0;
        }
        for(uint32_t i=0;i<tables[0].count;i++) {
            const size_t at=tables[0].offset+size_t(i)*12;
            types.push_back({reader.u16(at),reader.u16(at+2),reader.u16(at+4),reader.u16(at+6),reader.u16(at+8),reader.u16(at+10)});
        }
        for(uint32_t i=0;i<tables[1].count;i++) {
            const size_t at=tables[1].offset+size_t(i)*4;
            bases.push_back({reader.u16(at),reader.u16(at+2)});
        }
        for(uint32_t i=0;i<tables[2].count;i++) {
            const size_t at=tables[2].offset+size_t(i)*8;
            fields.push_back({reader.u16(at),reader.u16(at+2),reader.u16(at+4),reader.bytes[at+6],reader.bytes[at+7]});
        }
        for(uint32_t i=0;i<tables[4].count;i++) {
            const size_t at=tables[4].offset+size_t(i)*8;
            refs.push_back({reader.u32(at),reader.u16(at+4),reader.u16(at+6)});
        }
        for(uint32_t i=0;i<tables[5].count;i++) {
            const size_t at=tables[5].offset+size_t(i)*16;
            records.push_back({reader.u32(at),reader.u32(at+4),reader.u32(at+8),reader.u32(at+12)});
        }
        for(uint32_t i=0;i<tables[6].count;i++) {
            const size_t at=tables[6].offset+size_t(i)*6;
            components.push_back({reader.u16(at),reader.u16(at+2),reader.u16(at+4)});
        }
    }
    std::string name(uint16_t at) const {
        if(at>=strings.size())fail("XT schema name outside string table");
        size_t end=at;
        while(end<strings.size()&&strings[end]) {
            if(end-at>=4096)fail("XT schema name exceeds limit");
            if(strings[end]<32||strings[end]>126)fail("Unsupported XT schema name encoding");
            ++end;
        }
        if(end==strings.size())fail("Unterminated XT schema name");
        return std::string(reinterpret_cast<const char*>(strings.data()+at),end-at);
    }
    void validate_schema() {
        size_t base_at=0,field_at=0;
        for(auto& type:types) {
            name(type.name);
            if(type.behaviour>=4||(type.behaviour==0&&(type.atom==0||type.atom>=15))||(type.behaviour!=0&&type.atom!=0))
                fail("Invalid XT type behaviour/atom");
            if((type.behaviour==0&&type.fields)||(type.behaviour!=3&&type.bases))fail("Invalid XT atom/base count");
            if(type.bases>bases.size()-base_at||type.fields>fields.size()-field_at)fail("XT type schema range outside table");
            type.base_start=static_cast<uint32_t>(base_at);
            type.field_start=static_cast<uint32_t>(field_at);
            for(size_t j=0;j<type.bases;j++) {
                const auto& base=bases[base_at+j];
                if(base.type>=types.size())fail("XT base type index out of bounds");
                const auto& parent=types[base.type];
                if(parent.behaviour!=3||base.offset>type.size||parent.size>type.size-base.offset)fail("Invalid XT base type/range");
            }
            for(size_t j=0;j<type.fields;j++) {
                const auto& field=fields[field_at+j];name(field.name);
                if(field.behaviour>=7)fail("Invalid XT field behaviour");
                if(type.behaviour==1||type.behaviour==2) {
                    if(field.type!=65535||field.offset||field.behaviour!=6||field.array)fail("Invalid XT enum/flag label");
                } else if(type.behaviour==3) {
                    if(field.type>=types.size()||field.behaviour>=6)fail("Invalid XT struct field type");
                    const auto& target=types[field.type];
                    constexpr uint16_t expected[]={0,1,2,3,3,3};
                    if(target.behaviour!=expected[field.behaviour])fail("Mismatched XT field/type behaviour");
                    const uint32_t width=field.array?8:field.behaviour>=4?4:target.size;
                    if(field.offset>type.size||width>uint32_t(type.size-field.offset))fail("XT field exceeds containing type");
                }
            }
            base_at+=type.bases;field_at+=type.fields;
        }
        if(base_at!=bases.size()||field_at!=fields.size())fail("Unused XT schema table rows");
    }
    void validate_records() {
        uint32_t last_id=0;
        for(const auto& ref:refs) {
            if(ref.id<=last_id||ref.type>=types.size()||(ref.record!=65535&&ref.record>=records.size()))fail("Invalid XT ref ordering/type/record");
            last_id=ref.id;
        }
        size_t component_at=0;uint64_t data_at=0;
        for(auto& record:records) {
            if(record.ref>=refs.size()||record.components==0||record.components>components.size()-component_at)
                fail("Invalid XT record/component range");
            uint64_t used=0;
            for(uint32_t j=0;j<record.components;j++) {
                const auto& component=components[component_at+j];
                if(component.type>=types.size()||component.behaviour>=3)fail("Invalid XT component type/behaviour");
                const uint64_t width=component.behaviour==0?types[component.type].size:4;
                used=(used+width*component.count+3)&~uint64_t(3);
            }
            const uint64_t record_bytes=uint64_t(record.bytes)+record.strings;
            if(used!=record.bytes||data_at>tables[7].count||record_bytes>tables[7].count-data_at)fail("XT record data extent mismatch");
            record.component_start=static_cast<uint32_t>(component_at);
            record.data_offset=tables[7].offset+static_cast<uint32_t>(data_at);
            component_at+=record.components;data_at+=record_bytes;
        }
        if(component_at!=components.size()||data_at!=tables[7].count)fail("Unused XT component/data bytes");
    }
    std::string json() const {
        // Bound repeated schema-name expansion before constructing a large JSON
        // stream: many fields may legally reference the same long string.
        uint64_t estimate=2048+uint64_t(types.size())*200+uint64_t(fields.size())*130+uint64_t(records.size())*200;
        for(const auto& type:types)estimate+=name(type.name).size()*2+8;
        for(const auto& field:fields)estimate+=name(field.name).size()*2+8;
        if(estimate>max_output)fail("XT JSON output estimate exceeds limit");
        std::ostringstream out;out.imbue(std::locale::classic());
        out<<"{\"status\":\"ok\",\"format\":\"FLSK\",\"version\":"<<version<<",\"endian\":\"little\",\"inputBytes\":"<<reader.length
           <<",\"schemaBoundsValidated\":true,\"recordPayloadValidated\":false,\"runtimeObjectsCreated\":false,\"integrityValidated\":false,\"tables\":{";
        for(size_t i=0;i<tables.size();i++) {
            if(i)out<<',';
            out<<quote(table_names[i])<<":{\"offset\":"<<tables[i].offset<<",\"count\":"<<tables[i].count<<",\"elementBytes\":"<<table_widths[i]<<'}';
        }
        out<<"},\"types\":[";
        for(size_t i=0;i<types.size();i++) {
            const auto& t=types[i];if(i)out<<',';
            out<<"{\"index\":"<<i<<",\"name\":"<<quote(name(t.name))<<",\"behaviour\":"<<t.behaviour<<",\"atom\":"<<t.atom<<",\"size\":"<<t.size
               <<",\"baseStart\":"<<t.base_start<<",\"baseCount\":"<<t.bases<<",\"fieldStart\":"<<t.field_start<<",\"fieldCount\":"<<t.fields<<'}';
        }
        out<<"],\"fields\":[";
        for(size_t i=0;i<fields.size();i++) {
            const auto& f=fields[i];if(i)out<<',';
            out<<"{\"index\":"<<i<<",\"name\":"<<quote(name(f.name))<<",\"typeIndex\":";
            if(f.type==65535)out<<"null";else out<<f.type;
            out<<",\"offset\":"<<f.offset<<",\"behaviour\":"<<unsigned(f.behaviour)<<",\"array\":"<<(f.array?"true":"false")<<'}';
        }
        out<<"],\"records\":[";
        for(size_t i=0;i<records.size();i++) {
            const auto& record=records[i];const auto& ref=refs[record.ref];if(i)out<<',';
            out<<"{\"index\":"<<i<<",\"id\":"<<ref.id<<",\"typeIndex\":"<<ref.type<<",\"componentStart\":"<<record.component_start
               <<",\"componentCount\":"<<record.components<<",\"dataOffset\":"<<record.data_offset<<",\"dataBytes\":"<<record.bytes<<",\"stringBytes\":"<<record.strings<<'}';
        }
        out<<"]}";
        auto result=out.str();if(result.size()>max_output)fail("XT JSON output exceeds limit");return result;
    }
    std::string run(){read_header();read_tables();validate_schema();validate_records();return json();}
};
char* allocate(const std::string& text){auto* output=static_cast<char*>(std::malloc(text.size()+1));if(output)std::memcpy(output,text.c_str(),text.size()+1);return output;}
}
extern "C" char* xt_inspect(const unsigned char* bytes,size_t available) {
    try {
        if(!bytes||available<header_bytes||available>max_input)throw std::runtime_error("XT input outside supported bounds");
        Inspector inspector{{bytes,available}};return allocate(inspector.run());
    }catch(const std::exception& error){return allocate("{\"status\":\"error\",\"error\":"+quote(error.what())+"}");}
    catch(...){return allocate("{\"status\":\"error\",\"error\":\"XT allocation failure\"}");}
}
extern "C" void xt_free(void* pointer){std::free(pointer);}
