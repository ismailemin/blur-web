#include "level_index_range.h"

#include <cstdint>
#include <cstring>
#include <limits>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace rangefile {
namespace {

constexpr uint64_t kMaxInput = 64ull * 1024ull * 1024ull;
constexpr uint64_t kLevelInputLimit = 16ull * 1024ull * 1024ull;
constexpr uint32_t kMaxCount = 100000;
constexpr uint64_t kSafeInteger = 9007199254740991ull;

struct Chunk {
    uint64_t start = 0;
    uint64_t end = 0;
    uint64_t payload = 0;
    uint16_t count = 0;
    uint8_t type = 0;
    std::string id;
};

struct Element {
    int32_t type = 0;
    int32_t method = 0;
    int32_t usage = 0;
    int32_t index = 0;
    uint16_t offset = 0;
};

struct MaterialField {
    std::string name;
    int32_t type = 0;
    uint32_t count = 0;
};

struct MaterialType {
    std::vector<MaterialField> fields;
};

// Random-access cursor over RangeFile with the same block bounds as the
// asset-reader Reader. Every byte read goes through a bounded source range.
class LevelReader {
public:
    LevelReader(RangeFile& file, uint64_t position, uint64_t end)
        : file_(file), end_(end), position_(position) {
        if (end_ > file_.size() || position_ > end_)
            throw std::runtime_error("Invalid reader bounds");
    }

    RangeFile& file() { return file_; }
    uint64_t position() const { return position_; }
    uint64_t end() const { return end_; }
    void setEnd(uint64_t end) {
        if (end > file_.size()) fail("Reader end exceeds file size");
        end_ = end;
    }
    void setPosition(uint64_t position) { position_ = position; }

    [[noreturn]] void fail(const std::string& message) const {
        throw std::runtime_error(message + " at byte " + std::to_string(position_));
    }

    void need(uint64_t n) const {
        if (position_ > end_ || n > end_ - position_) fail("Truncated scene");
    }

    void skip(uint64_t n) {
        need(n);
        position_ += n;
    }

    void readRaw(uint64_t offset, void* destination, size_t n) {
        if (offset > end_ || n > end_ - offset) fail("Truncated scene");
        file_.readAt(offset, destination, n);
    }

    uint8_t u8() {
        uint8_t value = 0;
        readRaw(position_, &value, 1);
        ++position_;
        return value;
    }

    uint16_t u16() {
        uint8_t bytes[2]{};
        readRaw(position_, bytes, sizeof bytes);
        position_ += sizeof bytes;
        return static_cast<uint16_t>(static_cast<uint16_t>(bytes[0]) |
                                     static_cast<uint16_t>(bytes[1]) << 8);
    }

    uint32_t u32() {
        uint8_t bytes[4]{};
        readRaw(position_, bytes, sizeof bytes);
        position_ += sizeof bytes;
        return static_cast<uint32_t>(bytes[0]) | static_cast<uint32_t>(bytes[1]) << 8 |
               static_cast<uint32_t>(bytes[2]) << 16 |
               static_cast<uint32_t>(bytes[3]) << 24;
    }

    uint64_t u64() {
        const uint64_t lo = u32();
        const uint64_t hi = u32();
        return lo | (hi << 32);
    }

    int32_t s32() { return static_cast<int32_t>(u32()); }

    void expect(uint32_t value) {
        if (u32() != value) fail("Unsupported serialized value");
    }

    uint16_t ar(uint16_t maxVersion = 0) {
        if (++objects_ > kMaxCount) fail("Archive object limit");
        if (u16() != 0x4152) fail("Missing RA object marker");
        const uint16_t version = u16();
        if (version > maxVersion) fail("Unsupported object version");
        return version;
    }

    uint32_t count(uint32_t limit = kMaxCount) {
        const uint32_t value = u32();
        if (value > limit) fail("Collection limit");
        return value;
    }

    uint32_t vec(uint32_t limit = kMaxCount) {
        ar();
        return count(limit);
    }

    std::string str() {
        const uint32_t n = count(4096);
        need(n);
        std::string value(static_cast<size_t>(n), '\0');
        if (n) readRaw(position_, &value[0], n);
        position_ += n;
        return value;
    }

    void literal(const char* value, size_t n) {
        need(n);
        uint8_t bytes[16]{};
        if (n > sizeof bytes) fail("Internal literal limit");
        readRaw(position_, bytes, n);
        if (std::memcmp(bytes, value, n)) fail("Unsupported archive signature");
        position_ += n;
    }

    void bitvector() {
        ar();
        const uint32_t bits = count(8 * 1024 * 1024);
        const uint32_t bytes = vec();
        if (bytes < (bits + 7) / 8) fail("Invalid bit vector byte count");
        skip(bytes);
    }

    void bounds() {
        ar();
        skip(32);
    }

    void node() {
        ar();
        (void)str();
        const uint32_t n = vec();
        skip(uint64_t(n) * 8);
        skip(16);
    }

    void cull() {
        const uint16_t version = ar(2);
        node();
        bounds();
        bitvector();
        if (version > 0) skip(4);
        if (version > 1) bitvector();
    }

    void root() {
        ar();
        cull();
    }

    bool pointer() {
        const uint8_t tag = u8();
        if (tag == 0) return false;
        if (tag != 2) fail("Unsupported non-polymorphic pointer tag");
        return true;
    }

private:
    RangeFile& file_;
    uint64_t end_ = 0;
    uint64_t position_ = 0;
    uint32_t objects_ = 0;
};

Chunk levelFileBlock(LevelReader& reader, uint64_t start, uint64_t parentEnd) {
    reader.setPosition(start);
    reader.need(16);
    uint8_t idBytes[8]{};
    reader.readRaw(start, idBytes, sizeof idBytes);
    size_t n = 0;
    while (n < 8 && idBytes[n]) {
        if (idBytes[n] < 32 || idBytes[n] > 126) reader.fail("Invalid level FileBlock ID");
        ++n;
    }
    if (n == 0 || n == 8) reader.fail("Unterminated level FileBlock ID");
    const std::string id(reinterpret_cast<const char*>(idBytes), n);
    reader.setPosition(start + 8);
    const uint32_t size = reader.u32();
    const uint16_t count = reader.u16();
    const uint8_t type = reader.u8();
    const uint8_t compression = reader.u8();
    if (size < 16 || start > parentEnd || uint64_t(size) > parentEnd - start || compression ||
        (type != 0x41 && type != 0x43))
        reader.fail("Unsupported level FileBlock bounds/type/compression");
    return {start, start + size, start + 16, count, type, id};
}

void texture(LevelReader& reader) {
    reader.ar();
    reader.ar();
    reader.expect(2);
    (void)reader.str();
    const uint16_t sampler = reader.ar(1);
    reader.skip(sampler ? 40 : 36);
    (void)reader.u32();  // hash
    const uint32_t size = reader.count(static_cast<uint32_t>(kMaxInput));
    reader.skip(size);
}

void streamData(LevelReader& reader, uint32_t resourceBlocks,
                std::vector<LevelStreamChunk>& chunks) {
    reader.ar();
    const uint16_t version = reader.ar(3);
    const uint32_t count = reader.vec(4096);
    for (uint32_t i = 0; i < count; ++i) {
        const uint16_t v = reader.ar(1);
        reader.bounds();
        LevelStreamChunk chunk;
        uint32_t items = reader.vec();
        for (uint32_t k = 0; k < items; ++k) {
            reader.ar();
            const int32_t block = reader.s32();
            const int32_t lod = reader.s32();
            if (block < 0 || static_cast<uint32_t>(block) >= resourceBlocks || lod < 0 ||
                lod > 63)
                reader.fail("Invalid stream item block/LOD");
            chunk.items.push_back({block, lod});
        }
        items = reader.vec();
        for (uint32_t k = 0; k < items; ++k) {
            const int32_t block = reader.s32();
            if (block < 0 || static_cast<uint32_t>(block) >= resourceBlocks)
                reader.fail("Invalid stream resource block");
        }
        items = reader.vec();
        for (uint32_t k = 0; k < items; ++k) {
            const int32_t dependency = reader.s32();
            if (dependency < 0 || static_cast<uint32_t>(dependency) >= count)
                reader.fail("Invalid stream prerequisite");
            chunk.prerequisites.push_back(dependency);
        }
        items = reader.vec();
        for (uint32_t k = 0; k < items; ++k) {
            const int32_t dependency = reader.s32();
            if (dependency < 0 || static_cast<uint32_t>(dependency) >= count)
                reader.fail("Invalid stream dependant");
        }
        chunk.offset = reader.u64();
        chunk.storedBytes = reader.u64();
        chunk.logicalBytes = v ? reader.u64() : chunk.storedBytes;
        if (chunk.offset > std::numeric_limits<uint64_t>::max() - chunk.storedBytes)
            reader.fail("Stream file range overflows");
        if (chunk.offset > kSafeInteger || chunk.storedBytes > kSafeInteger ||
            chunk.logicalBytes > kSafeInteger)
            reader.fail("Stream numbers exceed exact browser integer range");
        chunks.push_back(std::move(chunk));
    }
    uint32_t count2 = reader.vec();
    for (uint32_t k = 0; k < count2; ++k) reader.bitvector();
    if (version > 0) {
        count2 = reader.vec();
        for (uint32_t k = 0; k < count2; ++k) reader.bounds();
        count2 = reader.vec();
        for (uint32_t k = 0; k < count2; ++k) reader.bitvector();
    }
    if (version > 1) {
        count2 = reader.vec();
        for (uint32_t k = 0; k < count2; ++k) reader.bitvector();
    }
    if (version > 2) reader.skip(4);
}

MaterialType materialType(LevelReader& reader) {
    reader.ar();
    (void)reader.str();
    const uint32_t count = reader.vec(4096);
    MaterialType type;
    for (uint32_t i = 0; i < count; ++i) {
        reader.ar();
        MaterialField field;
        field.name = reader.str();
        field.type = reader.s32();
        field.count = reader.count(4096);
        if (field.type < 0 || field.type > 10) reader.fail("Unsupported material element type");
        type.fields.push_back(std::move(field));
    }
    reader.skip(8);
    const uint32_t offsets = reader.vec(4096);
    reader.skip(uint64_t(offsets) * 2);
    reader.skip(8);
    return type;
}

std::vector<MaterialType> materialTypes(LevelReader& reader) {
    const uint32_t count = reader.vec(4096);
    std::vector<MaterialType> types;
    types.reserve(count);
    for (uint32_t i = 0; i < count; ++i) types.push_back(materialType(reader));
    return types;
}

void materialData(LevelReader& reader, const std::vector<MaterialType>& types) {
    const uint32_t count = reader.count(10000);
    (void)reader.count(static_cast<uint32_t>(kMaxInput));
    for (uint32_t i = 0; i < count; ++i) {
        const uint32_t index = reader.count();
        if (index >= types.size()) reader.fail("Material type reference out of bounds");
        bool hasProp = false;
        bool hasVehicle = false;
        for (const MaterialField& field : types[index].fields) {
            const uint64_t size = field.type < 2 ? 1 : field.type < 4 ? 2 : 4;
            const bool albedo = field.name == "g_tAlbedo" || field.name == "g_MeshTexture";
            if (albedo) {
                bool& seen = field.name == "g_tAlbedo" ? hasProp : hasVehicle;
                if (seen) reader.fail("Ambiguous albedo material parameter");
                seen = true;
            }
            if (albedo && field.type == 7 && field.count == 1) {
                (void)reader.s32();
            } else if (field.type == 8 || field.type == 9) {
                for (uint32_t j = 0; j < field.count; ++j) {
                    reader.ar();
                    (void)reader.s32();
                    (void)reader.s32();
                }
            } else {
                reader.skip(size * field.count);
            }
        }
    }
}

void materialList(LevelReader& reader) {
    reader.ar();
    reader.ar();
    const std::vector<MaterialType> types = materialTypes(reader);
    materialData(reader, types);
}

void dynamicLists(LevelReader& reader) {
    const uint32_t count = reader.vec(256);
    for (uint32_t i = 0; i < count; ++i) {
        if (reader.pointer()) materialList(reader);
    }
}

void sceneHeader(LevelReader& reader, uint32_t& resourceBlocks, uint32_t& loadedBlocks,
                 std::vector<LevelStreamChunk>& chunks) {
    const uint16_t targetVersion = reader.ar(1);
    reader.ar();
    reader.expect(2);
    reader.ar();
    (void)reader.str();
    reader.root();

    const uint32_t declarations = reader.vec(256);
    for (uint32_t i = 0; i < declarations; ++i) {
        reader.ar();
        const uint32_t n = reader.count(32);
        for (uint32_t j = 0; j < n; ++j) {
            reader.ar();
            (void)reader.u16();  // stream (int16)
            (void)reader.u16();  // offset
            (void)reader.s32();  // type
            (void)reader.s32();  // method
            (void)reader.s32();  // usage
            (void)reader.u8();   // index (int8)
        }
    }

    const uint32_t effects = reader.vec(256);
    for (uint32_t i = 0; i < effects; ++i) {
        reader.ar();
        reader.ar();
        (void)reader.str();
    }

    const uint32_t blocks = reader.count(100000);
    if (!blocks) reader.fail("No resource blocks");
    resourceBlocks = blocks;

    reader.ar();
    reader.ar();
    reader.expect(2);
    const uint32_t shared = reader.count(4096);
    for (uint32_t i = 0; i < shared; ++i) {
        (void)reader.str();
        reader.skip(4);
        texture(reader);
    }

    // streamData validates item resource-block IDs against the block count.
    streamData(reader, resourceBlocks, chunks);

    if (targetVersion > 0) dynamicLists(reader);

    const uint32_t loaded = reader.count(100000);
    if (loaded > blocks || !loaded) reader.fail("Unsupported absent resource blocks");
    loadedBlocks = loaded;
}

void levelSceneHeader(LevelReader& reader, uint32_t& resourceBlocks, uint32_t& loadedBlocks,
                      std::vector<LevelStreamChunk>& chunks) {
    reader.literal("  CP", 4);
    const Chunk render = levelFileBlock(reader, 4, reader.end());
    if (render.id != "Render") reader.fail("Expected level Render FileBlock");
    Chunk header{};
    Chunk scene{};
    bool gotHeader = false;
    bool gotScene = false;
    uint64_t at = render.payload;
    uint32_t children = 0;
    while (at < render.end) {
        if (++children > 10000) reader.fail("Level FileBlock child limit");
        const Chunk child = levelFileBlock(reader, at, render.end);
        at = child.end;
        if (child.id == "Header") {
            if (gotHeader) reader.fail("Duplicate level Header");
            header = child;
            gotHeader = true;
        }
        if (child.id == "Scene") {
            if (gotScene) reader.fail("Duplicate level Scene");
            scene = child;
            gotScene = true;
        }
    }
    if (!gotHeader || !gotScene || header.type != 0x41 || scene.type != 0x41)
        reader.fail("Missing level Header or Scene data block");

    LevelReader headerReader(reader.file(), header.payload, header.end);
    const uint32_t version = headerReader.u32();
    if (version > 1) headerReader.fail("Unsupported level render Header version");
    if (version) (void)headerReader.str();
    if (headerReader.position() != header.end)
        headerReader.fail("Level render Header size mismatch");

    reader.setPosition(scene.payload);
    reader.setEnd(scene.end);
    reader.literal("ARCH", 4);
    reader.expect(1);
    reader.expect(0);
    reader.literal("ARCH", 4);
    reader.expect(0);
    reader.expect(1);
    sceneHeader(reader, resourceBlocks, loadedBlocks, chunks);
}

}  // namespace

LevelIndex parse_level_index(RangeFile& file) {
    if (file.size() < 20) throw std::runtime_error("Level input is smaller than 20 bytes");
    if (file.size() > kLevelInputLimit)
        throw std::runtime_error("Level input exceeds 16 MiB probe limit");
    // The reader starts at 0 and the level FileBlock traversal sets its own
    // end from Render/Scene sizes.
    LevelReader reader(file, 0, file.size());
    LevelIndex index;
    levelSceneHeader(reader, index.resourceBlockCount, index.initiallyLoadedBlocks,
                     index.streamChunks);
    index.parsedUntilOffset = reader.position();
    return index;
}

std::string level_index_json(const LevelIndex& index, const RangeStats& stats) {
    std::ostringstream output;
    output << "{\"status\":\"ok\",\"resourceBlockCount\":" << index.resourceBlockCount
           << ",\"initiallyLoadedBlocks\":" << index.initiallyLoadedBlocks
           << ",\"streamChunks\":[";
    for (size_t i = 0; i < index.streamChunks.size(); ++i) {
        if (i) output << ',';
        const LevelStreamChunk& chunk = index.streamChunks[i];
        output << "{\"offset\":" << chunk.offset
               << ",\"storedBytes\":" << chunk.storedBytes
               << ",\"logicalBytes\":" << chunk.logicalBytes
               << ",\"items\":[";
        for (size_t j = 0; j < chunk.items.size(); ++j) {
            if (j) output << ',';
            output << "{\"block\":" << chunk.items[j].block
                   << ",\"lod\":" << chunk.items[j].lod << '}';
        }
        output << "],\"prerequisites\":[";
        for (size_t j = 0; j < chunk.prerequisites.size(); ++j) {
            if (j) output << ',';
            output << chunk.prerequisites[j];
        }
        output << "]}";
    }
    output << "],\"metadata\":{\"streamIndexOnly\":true,\"integrityValidated\":false,"
           << "\"parsedUntilOffset\":" << index.parsedUntilOffset
           << ",\"scope\":\"Scene declarations and ChunkInfo records; resource blocks not imported\"}"
           << ",\"rangeRead\":{\"sourceSize\":" << stats.sourceSize
           << ",\"windowBytes\":" << stats.windowBytes
           << ",\"sourceRequests\":" << stats.sourceRequests
           << ",\"bytesRead\":" << stats.bytesRead
           << ",\"largestSourceRequest\":" << stats.largestSourceRequest
           << ",\"fullFileBytesCopied\":" << stats.fullFileBytesCopied
           << "}}";
    return output.str();
}

}  // namespace rangefile
