// Unit tests for the T-005b range reader and the range-driven PAK index.
// These tests use only synthetic bytes; real PAK/level parity is checked by
// tests/compare_reference.py against the existing native probes.

#include "byte_source.h"
#include "pak_index_range.h"
#include "range_file.h"

#include <cstdint>
#include <cstring>
#include <functional>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

void check(bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}

bool throws(const std::function<void()>& action) {
    try {
        action();
    } catch (const std::exception&) {
        return true;
    }
    return false;
}

std::vector<uint8_t> pattern(size_t size) {
    std::vector<uint8_t> bytes(size);
    for (size_t i = 0; i < size; ++i) bytes[i] = static_cast<uint8_t>((i * 37 + 11) & 0xff);
    return bytes;
}

// A source that deliberately fails part-way through the first request. The
// bytes it does write must not be supplemented with zeros by RangeFile.
class PartialThenThrowSource final : public rangefile::ByteSource {
public:
    uint64_t size() const override { return 100; }
    const char* kind() const override { return "partial-throw"; }
    void read(uint64_t offset, uint8_t* destination, size_t length) override {
        (void)offset;
        ++calls;
        const size_t written = length < 4 ? length : 4;
        std::memset(destination, 0x5a, written);
        throw std::runtime_error("simulated unavailable range");
    }
    unsigned calls = 0;
};

class EmptyThrowSource final : public rangefile::ByteSource {
public:
    uint64_t size() const override { return 100; }
    const char* kind() const override { return "empty-throw"; }
    void read(uint64_t, uint8_t*, size_t) override {
        ++calls;
        throw std::runtime_error("simulated missing range");
    }
    unsigned calls = 0;
};

void put(std::vector<uint8_t>& bytes, size_t offset, uint64_t value, unsigned width = 4,
         bool big = false) {
    for (unsigned i = 0; i < width; ++i) {
        bytes[offset + (big ? width - i - 1 : i)] = static_cast<uint8_t>(value >> (i * 8));
    }
}

// Same synthetic layout as probes/asset-reader/tests/pak_reader_tests.cpp.
std::vector<uint8_t> pakFixture(bool big = false, bool secure = false, bool v1 = false) {
    std::vector<uint8_t> bytes(256, 0);
    std::memcpy(bytes.data(), big ? "PAK2" : "2KAP", 4);
    put(bytes, 4, v1 ? 1 : 2, 4, big);
    put(bytes, 8, 64, 4, big);
    put(bytes, 12, v1 ? 40 : 32, 4, big);
    const size_t settings = v1 ? 36 : 16;
    bytes[settings] = 1;
    bytes[settings + 1] = secure ? 1 : 0;
    bytes[settings + 2] = '\\';
    const size_t strings = v1 ? 56 : 64;
    const std::string name = "\\tiny.model";
    put(bytes, strings, name.size() + 1, 4, big);
    constexpr unsigned char cipher[] = "xVXo40j3@$%\\%`";
    for (size_t i = 0; i <= name.size(); ++i) {
        bytes[strings + 4 + i] = static_cast<uint8_t>((i < name.size() ? name[i] : 0) ^
                                                      cipher[(i + 1) % 14]);
    }
    const uint32_t stride = (v1 ? 32u : 40u) + (secure ? 24u : 0u);
    if (!v1) {
        put(bytes, 36, 64, 4, big);
        put(bytes, 40, secure ? 128 : 64, 4, big);
    }
    put(bytes, 128, 1, 4, big);
    put(bytes, 132, stride, 4, big);
    put(bytes, 136, 123, 4, big);
    put(bytes, 140, 0, 4, big);
    put(bytes, 144, UINT32_MAX, 4, big);
    put(bytes, 148, 4, 4, big);
    put(bytes, 160, secure ? 4 : 3, 8, big);
    if (!v1) put(bytes, 172, 4, 4, big);
    if (secure) bytes.resize(320, 0);
    return bytes;
}

void testRangeValidation() {
    rangefile::MemoryByteSource source(pattern(100));
    rangefile::RangeFile file(source, 16);
    uint8_t destination[8]{};

    check(throws([&] { file.readAt(100, destination, 1); }),
          "Read at EOF must be rejected");
    check(throws([&] { file.readAt(101, destination, 1); }),
          "Read past EOF must be rejected");
    check(throws([&] { file.readAt(90, destination, 11); }),
          "Read underflowing EOF must be rejected");
    check(throws([&] { file.readAt(0, destination, 0); }),
          "Zero-length range must be rejected");
    check(throws([&] { file.readAt(UINT64_MAX, destination, 2); }),
          "Offset+length overflow must be rejected");
    check(throws([&] { file.readAt(0, nullptr, 1); }),
          "Null destination must be rejected");
    check(throws([&] { file.seek(101); }), "Seek past EOF must be rejected");
    file.seek(90);
    check(throws([&] { file.skip(11); }), "Skip past EOF must be rejected");
    file.seek(0);
    check(file.stats().sourceRequests == 0,
          "Rejected ranges must not issue source requests");
    check(throws([&] { rangefile::RangeFile bad(source, 0); }),
          "Zero window must be rejected");
    check(throws([&] { rangefile::RangeFile bad(source, rangefile::RangeFile::kMaxWindow + 1); }),
          "Oversized window must be rejected");
    std::cout << "PASS range validation (7 rejected shapes, no source call)\n";
}

void testSliceBoundaries() {
    const auto bytes = pattern(1000);
    rangefile::MemoryByteSource source(bytes);
    rangefile::RangeFile file(source, 64);

    std::vector<uint8_t> all(1000);
    file.readAt(0, all.data(), all.size());
    check(all == bytes, "Windowed copy must equal source bytes");
    check(file.stats().sourceRequests == 16, "1000 bytes at window 64 is 16 source calls");
    check(file.stats().bytesRead == 1000, "Bytes read must equal the request");
    check(file.stats().largestSourceRequest == 64, "Largest source request must equal window");
    check(file.stats().fullFileBytesCopied == 0, "No whole-file copy may be recorded");

    uint8_t pair[2]{};
    file.readAt(63, pair, 2);
    check(pair[0] == bytes[63] && pair[1] == bytes[64], "Read crossing a window boundary");
    uint8_t block[64]{};
    file.readAt(64, block, 64);
    check(std::memcmp(block, bytes.data() + 64, 64) == 0, "Read starting on a boundary");
    uint8_t last = 0;
    file.readAt(999, &last, 1);
    check(last == bytes[999], "Read of the final byte");
    check(throws([&] { file.readAt(994, block, 7); }), "Read ending past EOF must fail");

    file.seek(62);
    const uint32_t word = static_cast<uint32_t>(bytes[62]) |
                          static_cast<uint32_t>(bytes[63]) << 8 |
                          static_cast<uint32_t>(bytes[64]) << 16 |
                          static_cast<uint32_t>(bytes[65]) << 24;
    check(file.u32le() == word, "Typed read across a window boundary");
    file.seek(995);
    check(throws([&] { (void)file.u64le(); }), "Typed read underflowing EOF must fail");
    check(file.position() == 995, "Failed typed read must not advance the cursor");

    file.seek(0);
    std::vector<uint8_t> again(1000);
    file.read(again.data(), again.size());
    check(again == bytes, "Cursor read must match random-access read");
    std::cout << "PASS slice boundaries (16 windowed reads, boundary and EOF cases)\n";
}

void testNoZeroFill() {
    PartialThenThrowSource partial;
    rangefile::RangeFile file(partial, 8);
    uint8_t destination[16];
    std::memset(destination, 0xaa, sizeof destination);
    check(throws([&] { file.readAt(0, destination, sizeof destination); }),
          "Partial source must propagate as an error");
    for (size_t i = 0; i < 4; ++i) check(destination[i] == 0x5a, "Source bytes must be preserved");
    for (size_t i = 4; i < sizeof destination; ++i)
        check(destination[i] == 0xaa, "Missing bytes must not be zero-filled or overwritten");
    check(file.stats().bytesRead == 0, "Failed source read must not count as read bytes");

    EmptyThrowSource empty;
    rangefile::RangeFile second(empty, 8);
    std::memset(destination, 0xcc, sizeof destination);
    check(throws([&] { second.readAt(0, destination, sizeof destination); }),
          "Missing range must propagate as an error");
    for (uint8_t value : destination)
        check(value == 0xcc, "A missing range must leave the destination untouched");
    std::cout << "PASS no zero fill (partial and missing ranges)\n";
}

void testPakFixture() {
    for (bool big : {false, true}) {
        for (bool secure : {false, true}) {
            for (bool v1 : {false, true}) {
                const auto bytes = pakFixture(big, secure, v1);
                rangefile::MemoryByteSource source(bytes);
                // A 7-byte window forces the header, string table and every
                // FAT record to span several source requests.
                rangefile::RangeFile file(source, 7);
                const rangefile::PakIndex index = rangefile::parse_pak_index(file);
                check(index.version == (v1 ? 1u : 2u), "PAK version");
                check(index.sectorSize == 64, "PAK sector size");
                check(index.fileCount == 1, "PAK file count");
                check(index.entries.size() == 1, "PAK entry count");
                const auto& entry = index.entries[0];
                check(entry.path == "\\tiny.model", "PAK entry path");
                check(entry.pathCrc == 123, "PAK entry CRC");
                check(!entry.isDirectory, "PAK entry is a file");
                check(entry.logicalBytes == 4, "PAK logical size");
                check(entry.hasDataOffset && entry.dataOffset == (secure ? 256u : 192u),
                      "PAK payload offset");
                check(!entry.hasParent, "Root entry has no parent");
                if (v1) {
                    check(!entry.hasPhysical, "V1 has no physical size");
                } else {
                    check(entry.hasPhysical && entry.physicalBytes == 4, "V2 physical size");
                }
                check(file.stats().largestSourceRequest <= 7,
                      "PAK parse must stay inside the window");
                check(file.stats().fullFileBytesCopied == 0, "PAK parse must not copy the file");
            }
        }
    }
    std::cout << "PASS PAK fixture (8 endian/version/FAT combinations at window 7)\n";
}

void testPakDeterminism() {
    const auto bytes = pakFixture(false, true, false);
    rangefile::MemoryByteSource firstSource(bytes);
    rangefile::RangeFile first(firstSource, 13);
    const auto a = rangefile::parse_pak_index(first);
    rangefile::MemoryByteSource secondSource(bytes);
    rangefile::RangeFile second(secondSource, 13);
    const auto b = rangefile::parse_pak_index(second);
    check(rangefile::pak_index_json(a, first.stats()) ==
              rangefile::pak_index_json(b, second.stats()),
          "Repeated PAK parse must be byte-identical");

    // A different window may change the request statistics but not a record.
    rangefile::MemoryByteSource wideSource(bytes);
    rangefile::RangeFile wide(wideSource, 4096);
    const auto c = rangefile::parse_pak_index(wide);
    check(c.entries.size() == a.entries.size(), "Window-independent entry count");
    for (size_t i = 0; i < a.entries.size(); ++i) {
        check(a.entries[i].path == c.entries[i].path, "Window-independent path");
        check(a.entries[i].dataOffset == c.entries[i].dataOffset,
              "Window-independent payload offset");
        check(a.entries[i].logicalBytes == c.entries[i].logicalBytes,
              "Window-independent logical size");
    }
    std::cout << "PASS determinism (identical JSON, window-independent records)\n";
}

void testPakRejections() {
    const auto expectRejected = [](std::vector<uint8_t> bytes, const char* message) {
        rangefile::MemoryByteSource source(std::move(bytes));
        rangefile::RangeFile file(source, 64);
        check(throws([&] { (void)rangefile::parse_pak_index(file); }), message);
    };
    auto bad = pakFixture();
    put(bad, 4, 3);
    expectRejected(bad, "Unsupported PAK version must be rejected");
    bad = pakFixture();
    put(bad, 8, 63);
    expectRejected(bad, "Non-power-of-two sector must be rejected");
    bad = pakFixture();
    put(bad, 128, 100001);
    expectRejected(bad, "Entry count over limit must be rejected");
    bad = pakFixture();
    put(bad, 132, 39);
    expectRejected(bad, "FAT length mismatch must be rejected");
    bad = pakFixture();
    put(bad, 144, 1);
    expectRejected(bad, "Parent offset out of range must be rejected");
    bad = pakFixture();
    put(bad, 160, UINT64_MAX - 1, 8);
    expectRejected(bad, "Payload offset overflow must be rejected");
    bad = pakFixture();
    put(bad, 172, 200);
    expectRejected(bad, "Payload outside file must be rejected");
    bad = pakFixture();
    bad[17] = 2;
    expectRejected(bad, "Unsupported FAT type must be rejected");
    bad = pakFixture();
    bad[16] = 0;
    expectRejected(bad, "Unsupported codec must be rejected");
    bad = pakFixture();
    bad[64 + 4 + 11] ^= 1;
    expectRejected(bad, "Unterminated string table path must be rejected");
    auto truncated = pakFixture();
    truncated.resize(100);
    expectRejected(truncated, "Truncated FAT position must be rejected");
    std::cout << "PASS PAK rejections (11 malformed inputs)\n";
}

}  // namespace

int main() {
    try {
        testRangeValidation();
        testSliceBoundaries();
        testNoZeroFill();
        testPakFixture();
        testPakDeterminism();
        testPakRejections();
        std::cout << "PASS: range-file unit suite\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "FAIL: " << error.what() << '\n';
        return 1;
    }
}
