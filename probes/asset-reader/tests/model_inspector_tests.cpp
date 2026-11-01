#include "model_inspector.h"
#include <algorithm>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <string>
#include <vector>

namespace {
using Bytes = std::vector<unsigned char>;
unsigned checks = 0;
unsigned failures = 0;
void u32(Bytes& bytes, size_t offset, uint32_t value) {
    for (unsigned i = 0; i < 4; ++i) bytes[offset + i] = static_cast<unsigned char>(value >> (8 * i));
}
Bytes block(const char* name, unsigned type, unsigned count, const Bytes& payload = {}) {
    Bytes output(16 + payload.size());
    std::memcpy(output.data(), name, std::strlen(name));
    u32(output, 8, static_cast<uint32_t>(output.size()));
    output[12] = static_cast<unsigned char>(count);
    output[13] = static_cast<unsigned char>(count >> 8);
    output[14] = static_cast<unsigned char>(type);
    std::copy(payload.begin(), payload.end(), output.begin() + 16);
    return output;
}
Bytes file(const Bytes& root) { Bytes result{' ', ' ', 'C', 'P'}; result.insert(result.end(), root.begin(), root.end()); return result; }
void check(const char* name, const Bytes& data, const char* expected) {
    ++checks;
    char* raw = model_inspect(data.data(), data.size());
    const std::string result = raw ? raw : "null";
    model_free(raw);
    if (result.find(expected) == std::string::npos) { ++failures; std::cerr << "FAIL " << name << ": " << result << '\n'; }
}
}

int main() {
    const Bytes leaf = block("Render", 0x41, 0, Bytes{0, 1, 2, 3});
    Bytes good = file(block("Model", 0x43, 1, leaf));
    check("valid data remains opaque", good, "\"chunkCount\":2");
    check("empty input", {}, "\"status\":\"error\"");
    check("header shorter than minimum", Bytes(19), "\"status\":\"error\"");
    auto bad = good; bad.resize(bad.size() - 1); check("truncated root", bad, "Chunk size exceeds parent");
    bad = good; u32(bad, 28, 0xffffffffu); check("oversized child", bad, "Chunk size exceeds parent");
    bad = good; u32(bad, 28, 15); check("undersized child", bad, "smaller than header");
    bad = good; bad[0] = 'X'; check("wrong platform", bad, "Only little-endian PC");
    bad = good; bad[4] = 'X'; check("wrong root", bad, "Expected Model");
    bad = good; bad[16] = 2; check("too many children", bad, "Truncated chunk header");
    bad = good; bad[16] = 0; check("too few children", bad, "declared children");
    bad = good; bad[19] = 1; check("compressed container", bad, "Compressed container");
    bad = good; bad[18] = 0; check("unknown type", bad, "Unsupported chunk header type");
    bad = good; for (unsigned i = 0; i < 8; ++i) bad[4 + i] = 'x'; check("unterminated id", bad, "Unterminated");
    bad = good; bad[4] = 1; check("control id", bad, "Invalid chunk identifier");
    Bytes nested = block("Leaf", 0x41, 0);
    for (unsigned i = 0; i < 32; ++i) nested = block("Nest", 0x43, 1, nested);
    check("depth limit", file(block("Model", 0x43, 1, nested)), "depth exceeds 32");
    nested = block("Leaf", 0x41, 0);
    for (unsigned i = 0; i < 30; ++i) nested = block("Nest", 0x43, 1, nested);
    check("depth boundary accepted", file(block("Model", 0x43, 1, nested)), "\"chunkCount\":32");
    Bytes many = file(block("Model", 0x43, 0));
    const Bytes empty_leaf = block("Leaf", 0x41, 0);
    for (unsigned i = 0; i < 100000; ++i) many.insert(many.end(), empty_leaf.begin(), empty_leaf.end());
    check("total chunk count limit", many, "Chunk count exceeds 100000");
    Bytes trailing = good; const Bytes meta = block("MtaDbg", 0x41, 0, Bytes{2, 3}); trailing.insert(trailing.end(), meta.begin(), meta.end());
    check("trailing metadata chunk", trailing, "\"chunkCount\":3");
    const unsigned char tiny = 0;
    char* huge = model_inspect(&tiny, 64u * 1024u * 1024u + 1);
    ++checks; if (!huge || std::string(huge).find("64 MiB") == std::string::npos) ++failures; model_free(huge);
    std::cout << (checks - failures) << '/' << checks << " model inspector checks passed\n";
    return failures ? 1 : 0;
}
