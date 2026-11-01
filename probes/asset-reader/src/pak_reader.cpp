#include "pak_reader.h"
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
constexpr uint64_t kMetadataLimit = 64 * 1024 * 1024;
constexpr uint32_t kEntryLimit = 100000;
struct NeedMore { uint64_t bytes; };
struct Reader {
    const unsigned char* data;
    uint64_t available, size;
    bool big = false;
    void need(uint64_t end) const {
        if (end > size) throw std::runtime_error("Metadata range exceeds file size");
        if (end > kMetadataLimit) throw std::runtime_error("Metadata exceeds 64 MiB probe limit");
        if (end > available) throw NeedMore{end};
    }
    uint64_t number(uint64_t start, unsigned width) const {
        if (start > UINT64_MAX - width) throw std::runtime_error("Offset overflow");
        need(start + width);
        uint64_t value = 0;
        for (unsigned i = 0; i < width; ++i) {
            const unsigned index = big ? i : width - i - 1;
            value = (value << 8) | data[start + index];
        }
        return value;
    }
};
std::string quote(const std::string& input) {
    static const char hex[] = "0123456789abcdef";
    std::string output = "\"";
    for (unsigned char c : input) {
        if (c == '"' || c == '\\') { output += '\\'; output += char(c); }
        else if (c < 32 || c >= 127) { output += "\\u00"; output += hex[c >> 4]; output += hex[c & 15]; }
        else output += char(c);
    }
    return output + '"';
}
const char* codec_name(uint32_t value) {
    switch (value) { case 1:return "raw"; case 2:return "zlib"; case 3:return "xmem";
        case 4:return "packet-zlib"; case 5:return "packet-xmem"; default:return "unknown"; }
}
uint64_t advance_sector(uint64_t position, uint32_t sector) {
    // Upstream ReadStringTable consumes a complete padding sector on alignment.
    return position + sector - position % sector;
}
std::string inspect(Reader r) {
    r.need(12);
    if (std::memcmp(r.data, "2KAP", 4) == 0) r.big = false;
    else if (std::memcmp(r.data, "PAK2", 4) == 0) r.big = true;
    else throw std::runtime_error("Not a PAK2 file");
    const uint32_t version = uint32_t(r.number(4,4));
    const uint32_t sector = uint32_t(r.number(8,4));
    if (version != 1 && version != 2) throw std::runtime_error("Unsupported PAK version");
    if (!sector || sector > 32768 || (sector & (sector - 1))) throw std::runtime_error("Invalid sector size");
    const uint32_t header_size = uint32_t(r.number(12,4));
    if (header_size != (version == 2 ? 32u : 40u)) throw std::runtime_error("Unexpected PAK header size");
    r.need(16 + header_size);
    const uint64_t settings = version == 2 ? 16 : 36;
    const uint32_t codec = r.data[settings], fat_type = r.data[settings+1];
    if (codec < 1 || codec > 5) throw std::runtime_error("Unsupported PAK codec identifier");
    if (fat_type > 1) throw std::runtime_error("Unsupported FAT entry type");
    const uint32_t flags = uint32_t(r.number(settings+4,4));
    const uint32_t meta_offset = uint32_t(r.number(settings+8,4));
    uint64_t strings_position = 16 + header_size;
    uint32_t strings_block = 0, fat_block = 0;
    if (version == 2) {
        strings_position = sector;
        strings_block = uint32_t(r.number(36,4));
        fat_block = uint32_t(r.number(40,4));
        if (sector < 48 || !strings_block || !fat_block || strings_block % sector || fat_block % sector)
            throw std::runtime_error("Invalid metadata block layout");
        r.need(uint64_t(sector) + strings_block + fat_block);
    }
    const uint32_t string_size = uint32_t(r.number(strings_position,4));
    if (uint64_t(string_size) + 4 > kMetadataLimit) throw std::runtime_error("String table exceeds probe limit");
    const uint64_t string_end = strings_position + 4 + string_size;
    if (version == 2 && uint64_t(string_size) + 4 > strings_block)
        throw std::runtime_error("String table exceeds declared block");
    r.need(string_end);
    const uint64_t fat_position = version == 2 ? strings_position + strings_block : advance_sector(string_end,sector);
    const uint32_t count = uint32_t(r.number(fat_position,4));
    const uint32_t fat_size = uint32_t(r.number(fat_position+4,4));
    const uint32_t stride = (version == 2 ? 40 : 32) + (fat_type == 1 ? 24 : 0);
    if (count > kEntryLimit) throw std::runtime_error("Entry count exceeds probe limit");
    if (uint64_t(count) * stride != fat_size) throw std::runtime_error("FAT length does not match entry count");
    if (version == 2 && uint64_t(fat_size) + 8 > fat_block)
        throw std::runtime_error("FAT exceeds declared block");
    const uint64_t metadata_end = fat_position + 8 + fat_size;
    r.need(metadata_end);
    std::string strings(string_size,'\0');
    constexpr unsigned char cipher[] = "xVXo40j3@$%\\%`";
    for (uint32_t i = 0; i < string_size; ++i) strings[i] = char(r.data[strings_position+4+i] ^ cipher[(uint64_t(i)+1)%14]);
    const auto get_string = [&](uint32_t offset) {
        if (offset >= strings.size()) throw std::runtime_error("String table offset out of range");
        const size_t end = strings.find('\0',offset);
        if (end == std::string::npos) throw std::runtime_error("Unterminated path in string table");
        if (end - offset > 4096) throw std::runtime_error("Path exceeds probe limit");
        return strings.substr(offset,end-offset);
    };
    if (meta_offset != UINT32_MAX && string_size) (void)get_string(meta_offset);
    std::ostringstream output;
    output << "{\"status\":\"ok\",\"validationPerformed\":false,\"payloadDecoded\":false,\"header\":{"
        << "\"version\":" << version << ",\"sectorSize\":" << sector << ",\"codec\":" << codec
        << ",\"codecName\":" << quote(codec_name(codec)) << ",\"codecFlags\":" << flags
        << ",\"fatEntryType\":" << fat_type << ",\"fileCount\":" << count
        << ",\"stringTableBytes\":" << string_size << ",\"metadataBytes\":" << metadata_end
        << ",\"fileBytes\":" << r.size << ",\"endian\":" << quote(r.big ? "big" : "little") << "},\"entries\":[";
    uint64_t total_path_bytes = 0;
    for (uint32_t i = 0; i < count; ++i) {
        const uint64_t entry = fat_position+8+uint64_t(i)*stride;
        const uint32_t crc = uint32_t(r.number(entry,4)), path_offset = uint32_t(r.number(entry+4,4));
        const uint32_t parent = uint32_t(r.number(entry+8,4)), logical = uint32_t(r.number(entry+12,4));
        const uint64_t start_sector = r.number(entry+24,8);
        const bool directory = start_sector == UINT64_MAX;
        uint64_t data_offset = 0;
        uint32_t physical = version == 2 ? uint32_t(r.number(entry+36,4)) : 0;
        if (parent != UINT32_MAX && (parent % stride || parent / stride >= count))
            throw std::runtime_error("Parent FAT offset out of range");
        if (!directory) {
            if (start_sector > UINT64_MAX / sector) throw std::runtime_error("Payload offset overflow");
            data_offset = start_sector * sector;
            if (data_offset < metadata_end || data_offset > r.size || (version == 2 && physical > r.size-data_offset))
                throw std::runtime_error("Payload range outside file");
        }
        const std::string path = get_string(path_offset);
        total_path_bytes += path.size();
        if (total_path_bytes > 16*1024*1024) throw std::runtime_error("Total path data exceeds probe limit");
        if (i) output << ',';
        output << "{\"index\":" << i << ",\"path\":" << quote(path)
            << ",\"pathCrc\":" << crc << ",\"isDirectory\":" << (directory ? "true" : "false")
            << ",\"logicalBytes\":" << logical << ",\"physicalBytes\":";
        if (version == 2 && !directory) output << physical; else output << "null";
        output << ",\"dataOffset\":";
        if (directory) output << "null"; else output << data_offset;
        output << ",\"parentIndex\":";
        if (parent == UINT32_MAX) output << "null"; else output << parent/stride;
        output << '}';
    }
    output << "]}";
    return output.str();
}
char* duplicate(const std::string& value) {
    char* result = static_cast<char*>(std::malloc(value.size()+1));
    if (result) std::memcpy(result,value.c_str(),value.size()+1);
    return result;
}
}
extern "C" char* pak_inspect(const unsigned char* bytes, size_t available, double logical_file_size) {
    try {
        if (!std::isfinite(logical_file_size) || logical_file_size < 0 || logical_file_size > 9007199254740991.0 ||
            std::floor(logical_file_size) != logical_file_size)
            throw std::runtime_error("File size must be a nonnegative safe integer");
        if (!bytes && available) throw std::runtime_error("Null input buffer");
        const uint64_t size = static_cast<uint64_t>(logical_file_size);
        if (available > size) throw std::runtime_error("Prefix exceeds file size");
        return duplicate(inspect({bytes,static_cast<uint64_t>(available),size}));
    } catch (const NeedMore& request) {
        return duplicate("{\"status\":\"need_more\",\"requiredBytes\":"+std::to_string(request.bytes)+"}");
    } catch (const std::exception& error) {
        return duplicate("{\"status\":\"error\",\"error\":"+quote(error.what())+"}");
    } catch (...) { return duplicate("{\"status\":\"error\",\"error\":\"Unexpected parser failure\"}"); }
}
extern "C" void pak_free(void* pointer) { std::free(pointer); }
