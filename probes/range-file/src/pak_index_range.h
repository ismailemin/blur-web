#pragma once
// PAK metadata index read through RangeFile. The parser is an independent
// port of the existing pak_reader.cpp traversal; it shares no mutable state
// with the asset-reader probe and is not linked into it.

#include "range_file.h"

#include <cstdint>
#include <string>
#include <vector>

namespace rangefile {

struct PakEntry {
    uint32_t index = 0;
    std::string path;
    uint32_t pathCrc = 0;
    bool isDirectory = false;
    uint32_t logicalBytes = 0;
    bool hasPhysical = false;
    uint32_t physicalBytes = 0;
    bool hasDataOffset = false;
    uint64_t dataOffset = 0;
    bool hasParent = false;
    uint32_t parentIndex = 0;
};

struct PakIndex {
    uint32_t version = 0;
    uint32_t sectorSize = 0;
    uint32_t codec = 0;
    uint32_t codecFlags = 0;
    uint32_t fatEntryType = 0;
    uint32_t fileCount = 0;
    uint32_t stringTableBytes = 0;
    uint64_t metadataBytes = 0;
    uint64_t fileBytes = 0;
    bool bigEndian = false;
    std::vector<PakEntry> entries;
};

PakIndex parse_pak_index(RangeFile& file);
std::string pak_index_json(const PakIndex& index, const RangeStats& stats);

}  // namespace rangefile
