#pragma once
// Level.levelrender (Scene + ChunkInfo) index read through RangeFile. This is
// an independent port of the bounded traversal in asset-reader scene_reader.cpp
// (`level_index`), not a link against it. Only the index is produced; no
// geometry, material or instance is imported.

#include "range_file.h"

#include <cstdint>
#include <string>
#include <vector>

namespace rangefile {

struct LevelChunkItem {
    int32_t block = 0;
    int32_t lod = 0;
};

struct LevelStreamChunk {
    std::vector<LevelChunkItem> items;
    std::vector<int32_t> prerequisites;
    uint64_t offset = 0;
    uint64_t storedBytes = 0;
    uint64_t logicalBytes = 0;
};

struct LevelIndex {
    uint32_t resourceBlockCount = 0;
    uint32_t initiallyLoadedBlocks = 0;
    uint64_t parsedUntilOffset = 0;
    std::vector<LevelStreamChunk> streamChunks;
};

LevelIndex parse_level_index(RangeFile& file);
std::string level_index_json(const LevelIndex& index, const RangeStats& stats);

}  // namespace rangefile
