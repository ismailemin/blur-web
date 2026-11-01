#include "model_inspector.h"
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <sstream>
#include <stdexcept>
#include <string>

namespace {
constexpr size_t kInputLimit = 64u * 1024u * 1024u;
constexpr unsigned kDepthLimit = 32;
constexpr unsigned kChunkLimit = 100000;

std::string quote(const std::string& text) {
    std::string result = "\"";
    for (unsigned char character : text) {
        if (character == '"' || character == '\\') result += '\\';
        result += static_cast<char>(character);
    }
    return result + '"';
}

struct Inspector {
    const unsigned char* data;
    size_t length;
    unsigned chunk_count = 0;

    uint32_t u32(size_t offset) const {
        return uint32_t(data[offset]) | uint32_t(data[offset + 1]) << 8 |
            uint32_t(data[offset + 2]) << 16 | uint32_t(data[offset + 3]) << 24;
    }
    uint16_t u16(size_t offset) const {
        return uint16_t(data[offset]) | uint16_t(data[offset + 1]) << 8;
    }
    std::string id(size_t offset) const {
        std::string result;
        bool ended = false;
        for (size_t i = 0; i < 8; ++i) {
            const unsigned char value = data[offset + i];
            if (value == 0) { ended = true; break; }
            if (value < 0x20 || value > 0x7e) throw std::runtime_error("Invalid chunk identifier");
            result += static_cast<char>(value);
        }
        if (!ended || result.empty()) throw std::runtime_error("Unterminated or empty chunk identifier");
        return result;
    }

    std::string chunk(size_t offset, size_t parent_end, unsigned depth, size_t& next,
                      bool first = false) {
        if (depth > kDepthLimit) throw std::runtime_error("Chunk depth exceeds 32");
        if (++chunk_count > kChunkLimit) throw std::runtime_error("Chunk count exceeds 100000");
        if (offset > parent_end || parent_end - offset < 16)
            throw std::runtime_error("Truncated chunk header");
        const std::string name = id(offset);
        const uint32_t size = u32(offset + 8);
        const uint16_t count = u16(offset + 12);
        const uint8_t type = data[offset + 14];
        const uint8_t compression = data[offset + 15];
        if (size < 16 || size > parent_end - offset)
            throw std::runtime_error("Chunk size exceeds parent or is smaller than header");
        if (type != 0x41 && type != 0x43) throw std::runtime_error("Unsupported chunk header type");
        if (first && (name != "Model" || type != 0x43))
            throw std::runtime_error("Expected Model container after PC platform marker");
        next = offset + size;
        std::ostringstream output;
        output << "{\"id\":" << quote(name) << ",\"offset\":" << offset
               << ",\"bytes\":" << size << ",\"count\":" << count
               << ",\"type\":" << unsigned(type) << ",\"compression\":" << unsigned(compression)
               << ",\"children\":[";
        if (type == 0x43) {
            if (compression != 0) throw std::runtime_error("Compressed container is not supported by header inspector");
            size_t child_offset = offset + 16;
            for (unsigned i = 0; i < count; ++i) {
                if (i) output << ',';
                size_t child_end = 0;
                output << chunk(child_offset, next, depth + 1, child_end);
                child_offset = child_end;
            }
            if (child_offset != next) throw std::runtime_error("Container size does not match declared children");
        }
        // Data blocks are deliberately opaque, even when their payload resembles chunk headers.
        output << "]}";
        return output.str();
    }

    std::string inspect() {
        if (!data || length < 20) throw std::runtime_error("Input is shorter than platform marker plus model header");
        if (length > kInputLimit) throw std::runtime_error("Model input exceeds 64 MiB limit");
        if (std::memcmp(data, "  CP", 4) != 0) throw std::runtime_error("Only little-endian PC model data is supported");
        std::ostringstream output;
        output << "{\"status\":\"ok\",\"platform\":\"PC\",\"integrityValidated\":false,"
                  "\"inputBytes\":" << length << ",\"chunks\":[";
        size_t offset = 4;
        bool first = true;
        while (offset < length) {
            if (!first) output << ',';
            size_t next = 0;
            output << chunk(offset, length, 1, next, first);
            offset = next;
            first = false;
        }
        output << "],\"chunkCount\":" << chunk_count << '}';
        return output.str();
    }
};

char* allocate(const std::string& text) {
    char* output = static_cast<char*>(std::malloc(text.size() + 1));
    if (output) std::memcpy(output, text.c_str(), text.size() + 1);
    return output;
}
}

extern "C" char* model_inspect(const unsigned char* bytes, size_t available) {
    try { return allocate(Inspector{bytes, available}.inspect()); }
    catch (const std::exception& error) {
        return allocate("{\"status\":\"error\",\"integrityValidated\":false,\"message\":" + quote(error.what()) + '}');
    }
    catch (...) { return allocate("{\"status\":\"error\",\"integrityValidated\":false,\"message\":\"Unexpected inspector failure\"}"); }
}
extern "C" void model_free(void* pointer) { std::free(pointer); }
