#include "pak_index_range.h"

#include <cstdint>
#include <cstring>
#include <limits>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace rangefile {
namespace {

constexpr uint64_t kMetadataLimit = 64 * 1024 * 1024;
constexpr uint32_t kEntryLimit = 100000;
constexpr uint64_t kSafeInteger = 9007199254740991ull;

std::string quote(const std::string& input) {
    static const char hex[] = "0123456789abcdef";
    std::string output = "\"";
    for (unsigned char c : input) {
        if (c == '"' || c == '\\') {
            output += '\\';
            output += char(c);
        } else if (c < 32 || c >= 127) {
            output += "\\u00";
            output += hex[c >> 4];
            output += hex[c & 15];
        } else {
            output += char(c);
        }
    }
    return output + '"';
}

const char* codec_name(uint32_t value) {
    switch (value) {
        case 1: return "raw";
        case 2: return "zlib";
        case 3: return "xmem";
        case 4: return "packet-zlib";
        case 5: return "packet-xmem";
        default: return "unknown";
    }
}

// A fixed-size metadata window. It is read through RangeFile, so a field read
// is still one or more bounded source requests, never a file-sized buffer.
std::vector<uint8_t> read_window(RangeFile& file, uint64_t offset, size_t length) {
    std::vector<uint8_t> bytes(length);
    file.readAt(offset, bytes.data(), length);
    return bytes;
}

uint64_t number(const uint8_t* bytes, uint64_t start, unsigned width, bool big) {
    uint64_t value = 0;
    for (unsigned i = 0; i < width; ++i) {
        const unsigned index = big ? i : width - i - 1;
        value = (value << 8) | bytes[start + index];
    }
    return value;
}

uint64_t number_at(RangeFile& file, uint64_t offset, unsigned width, bool big) {
    const auto bytes = read_window(file, offset, width);
    return number(bytes.data(), 0, width, big);
}

uint64_t advance_sector(uint64_t position, uint32_t sector) {
    // Mirrors upstream ReadStringTable: an alignment consumes a complete
    // padding sector.
    return position + sector - position % sector;
}

}  // namespace

PakIndex parse_pak_index(RangeFile& file) {
    const uint64_t size = file.size();
    if (size < 16) throw std::runtime_error("PAK file is smaller than the 16-byte header");

    const auto header = read_window(file, 0, 16);
    bool big = false;
    if (std::memcmp(header.data(), "2KAP", 4) == 0) {
        big = false;
    } else if (std::memcmp(header.data(), "PAK2", 4) == 0) {
        big = true;
    } else {
        throw std::runtime_error("Not a PAK2 file");
    }

    const uint32_t version = static_cast<uint32_t>(number(header.data(), 4, 4, big));
    const uint32_t sector = static_cast<uint32_t>(number(header.data(), 8, 4, big));
    if (version != 1 && version != 2) throw std::runtime_error("Unsupported PAK version");
    if (!sector || sector > 32768 || (sector & (sector - 1)))
        throw std::runtime_error("Invalid sector size");

    const uint32_t headerSize = static_cast<uint32_t>(number(header.data(), 12, 4, big));
    if (headerSize != (version == 2 ? 32u : 40u))
        throw std::runtime_error("Unexpected PAK header size");
    const uint64_t settingsEnd = 16 + uint64_t(headerSize);
    if (settingsEnd > size) throw std::runtime_error("PAK header exceeds file size");
    if (settingsEnd > kMetadataLimit)
        throw std::runtime_error("Metadata exceeds 64 MiB probe limit");

    const auto prefix = read_window(file, 0, static_cast<size_t>(settingsEnd));
    const uint64_t settings = version == 2 ? 16 : 36;
    const uint32_t codec = prefix[static_cast<size_t>(settings)];
    const uint32_t fatType = prefix[static_cast<size_t>(settings) + 1];
    if (codec < 1 || codec > 5) throw std::runtime_error("Unsupported PAK codec identifier");
    if (fatType > 1) throw std::runtime_error("Unsupported FAT entry type");
    const uint32_t flags = static_cast<uint32_t>(number(prefix.data(), settings + 4, 4, big));
    const uint32_t metaOffset = static_cast<uint32_t>(number(prefix.data(), settings + 8, 4, big));

    uint64_t stringsPosition = 16 + headerSize;
    uint32_t stringsBlock = 0;
    uint32_t fatBlock = 0;
    if (version == 2) {
        stringsPosition = sector;
        stringsBlock = static_cast<uint32_t>(number(prefix.data(), 36, 4, big));
        fatBlock = static_cast<uint32_t>(number(prefix.data(), 40, 4, big));
        if (sector < 48 || !stringsBlock || !fatBlock || stringsBlock % sector ||
            fatBlock % sector)
            throw std::runtime_error("Invalid metadata block layout");
        const uint64_t declared = uint64_t(sector) + stringsBlock + fatBlock;
        if (declared > size) throw std::runtime_error("PAK metadata exceeds file size");
    }

    const uint32_t stringSize =
        static_cast<uint32_t>(number_at(file, stringsPosition, 4, big));
    if (uint64_t(stringSize) + 4 > kMetadataLimit)
        throw std::runtime_error("String table exceeds probe limit");
    if (version == 2 && uint64_t(stringSize) + 4 > stringsBlock)
        throw std::runtime_error("String table exceeds declared block");
    const uint64_t stringsEnd = stringsPosition + 4 + stringSize;
    if (stringsEnd > size) throw std::runtime_error("String table exceeds file size");

    // Bounded index buffer: the string table is metadata, not file content.
    // Decrypt in place to keep one buffer, not two.
    std::string strings(static_cast<size_t>(stringSize), '\0');
    if (stringSize) file.readAt(stringsPosition + 4,
                                 reinterpret_cast<uint8_t*>(&strings[0]), strings.size());
    constexpr unsigned char cipher[] = "xVXo40j3@$%\\%`";
    for (uint32_t i = 0; i < stringSize; ++i) {
        strings[i] = char(static_cast<unsigned char>(strings[i]) ^ cipher[(uint64_t(i) + 1) % 14]);
    }

    const uint64_t fatPosition =
        version == 2 ? stringsPosition + stringsBlock : advance_sector(stringsEnd, sector);
    if (fatPosition > size || size - fatPosition < 8)
        throw std::runtime_error("FAT position exceeds file size");
    const uint32_t count = static_cast<uint32_t>(number_at(file, fatPosition, 4, big));
    const uint32_t fatSize =
        static_cast<uint32_t>(number_at(file, fatPosition + 4, 4, big));
    const uint32_t stride = (version == 2 ? 40u : 32u) + (fatType == 1 ? 24u : 0u);
    if (count > kEntryLimit) throw std::runtime_error("Entry count exceeds probe limit");
    if (uint64_t(count) * stride != fatSize)
        throw std::runtime_error("FAT length does not match entry count");
    if (version == 2 && uint64_t(fatSize) + 8 > fatBlock)
        throw std::runtime_error("FAT exceeds declared block");
    const uint64_t metadataEnd = fatPosition + 8 + fatSize;
    if (metadataEnd > kMetadataLimit)
        throw std::runtime_error("Metadata exceeds 64 MiB probe limit");
    if (metadataEnd > size) throw std::runtime_error("FAT exceeds file size");

    const auto getString = [&](uint32_t offset) {
        if (offset >= strings.size())
            throw std::runtime_error("String table offset out of range");
        const size_t end = strings.find('\0', offset);
        if (end == std::string::npos)
            throw std::runtime_error("Unterminated path in string table");
        if (end - offset > 4096) throw std::runtime_error("Path exceeds probe limit");
        return strings.substr(offset, end - offset);
    };
    if (metaOffset != UINT32_MAX && stringSize) (void)getString(metaOffset);

    PakIndex index;
    index.version = version;
    index.sectorSize = sector;
    index.codec = codec;
    index.codecFlags = flags;
    index.fatEntryType = fatType;
    index.fileCount = count;
    index.stringTableBytes = stringSize;
    index.metadataBytes = metadataEnd;
    index.fileBytes = size;
    index.bigEndian = big;
    index.entries.reserve(count);

    uint64_t totalPathBytes = 0;
    for (uint32_t i = 0; i < count; ++i) {
        const uint64_t entryOffset = fatPosition + 8 + uint64_t(i) * stride;
        // One bounded source request per FAT record.
        const auto record = read_window(file, entryOffset, stride);

        PakEntry entry;
        entry.index = i;
        entry.pathCrc = static_cast<uint32_t>(number(record.data(), 0, 4, big));
        const uint32_t pathOffset =
            static_cast<uint32_t>(number(record.data(), 4, 4, big));
        const uint32_t parent = static_cast<uint32_t>(number(record.data(), 8, 4, big));
        entry.logicalBytes = static_cast<uint32_t>(number(record.data(), 12, 4, big));
        const uint64_t startSector = number(record.data(), 24, 8, big);
        entry.isDirectory = startSector == UINT64_MAX;
        const uint32_t physical =
            version == 2 ? static_cast<uint32_t>(number(record.data(), 36, 4, big)) : 0;

        if (parent != UINT32_MAX && (parent % stride || parent / stride >= count))
            throw std::runtime_error("Parent FAT offset out of range");

        if (!entry.isDirectory) {
            if (startSector > UINT64_MAX / sector)
                throw std::runtime_error("Payload offset overflow");
            const uint64_t dataOffset = startSector * sector;
            if (dataOffset < metadataEnd || dataOffset > size ||
                (version == 2 && physical > size - dataOffset))
                throw std::runtime_error("Payload range outside file");
            if (dataOffset > kSafeInteger)
                throw std::runtime_error("Payload offset exceeds exact browser integer range");
            entry.hasDataOffset = true;
            entry.dataOffset = dataOffset;
            if (version == 2) {
                entry.hasPhysical = true;
                entry.physicalBytes = physical;
            }
        }

        entry.path = getString(pathOffset);
        totalPathBytes += entry.path.size();
        if (totalPathBytes > 16 * 1024 * 1024)
            throw std::runtime_error("Total path data exceeds probe limit");
        if (parent != UINT32_MAX) {
            entry.hasParent = true;
            entry.parentIndex = parent / stride;
        }
        index.entries.push_back(std::move(entry));
    }

    return index;
}

std::string pak_index_json(const PakIndex& index, const RangeStats& stats) {
    std::ostringstream output;
    output << "{\"status\":\"ok\",\"validationPerformed\":false,\"payloadDecoded\":false,"
           << "\"header\":{\"version\":" << index.version
           << ",\"sectorSize\":" << index.sectorSize
           << ",\"codec\":" << index.codec
           << ",\"codecName\":" << quote(codec_name(index.codec))
           << ",\"codecFlags\":" << index.codecFlags
           << ",\"fatEntryType\":" << index.fatEntryType
           << ",\"fileCount\":" << index.fileCount
           << ",\"stringTableBytes\":" << index.stringTableBytes
           << ",\"metadataBytes\":" << index.metadataBytes
           << ",\"fileBytes\":" << index.fileBytes
           << ",\"endian\":" << quote(index.bigEndian ? "big" : "little")
           << "},\"entries\":[";
    for (size_t i = 0; i < index.entries.size(); ++i) {
        const PakEntry& entry = index.entries[i];
        if (i) output << ',';
        output << "{\"index\":" << entry.index
               << ",\"path\":" << quote(entry.path)
               << ",\"pathCrc\":" << entry.pathCrc
               << ",\"isDirectory\":" << (entry.isDirectory ? "true" : "false")
               << ",\"logicalBytes\":" << entry.logicalBytes
               << ",\"physicalBytes\":";
        if (entry.hasPhysical) output << entry.physicalBytes; else output << "null";
        output << ",\"dataOffset\":";
        if (entry.hasDataOffset) output << entry.dataOffset; else output << "null";
        output << ",\"parentIndex\":";
        if (entry.hasParent) output << entry.parentIndex; else output << "null";
        output << '}';
    }
    output << "],\"rangeRead\":{\"sourceSize\":" << stats.sourceSize
           << ",\"windowBytes\":" << stats.windowBytes
           << ",\"sourceRequests\":" << stats.sourceRequests
           << ",\"bytesRead\":" << stats.bytesRead
           << ",\"largestSourceRequest\":" << stats.largestSourceRequest
           << ",\"fullFileBytesCopied\":" << stats.fullFileBytesCopied
           << "}}";
    return output.str();
}

}  // namespace rangefile
