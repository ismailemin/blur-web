#pragma once
// Bounded range reader. The only way bytes enter the parser is through
// RangeFile::readAt(), which splits a request into source reads of at most
// `windowBytes` bytes. No buffer of the source size is ever created.

#include "byte_source.h"

#include <cstddef>
#include <cstdint>
#include <string>

namespace rangefile {

struct RangeStats {
    uint64_t sourceSize = 0;
    uint64_t windowBytes = 0;
    uint64_t sourceRequests = 0;
    uint64_t bytesRead = 0;
    uint64_t largestSourceRequest = 0;
    // This probe never hands the whole source to a parser; keep the field so a
    // future implementation cannot claim otherwise by accident.
    uint64_t fullFileBytesCopied = 0;
};

class RangeFile {
public:
    static constexpr size_t kDefaultWindow = 64 * 1024;
    static constexpr size_t kMaxWindow = 16 * 1024 * 1024;

    explicit RangeFile(ByteSource& source, size_t windowBytes = kDefaultWindow);

    uint64_t size() const { return size_; }
    size_t window() const { return window_; }
    uint64_t position() const { return position_; }
    uint64_t remaining() const { return size_ - position_; }

    // Sets the cursor. position may equal size (EOF); it must not exceed it.
    void seek(uint64_t position);
    void skip(uint64_t bytes);
    void rewind() { position_ = 0; }

    // Reads exactly `length` bytes at `offset` into `destination`. A request
    // that is zero length, starts past the end, underflows the end, or
    // overflows offset+length is rejected before any source call.
    void readAt(uint64_t offset, void* destination, size_t length);

    // Cursor-based read; advances position by `length`.
    void read(void* destination, size_t length);
    void skipRead(uint64_t bytes) { skip(bytes); }

    uint8_t u8();
    uint16_t u16le();
    uint32_t u32le();
    uint64_t u64le();

    const RangeStats& stats() const { return stats_; }

private:
    void checkRange(uint64_t offset, uint64_t length) const;

    ByteSource& source_;
    uint64_t size_ = 0;
    size_t window_ = 0;
    uint64_t position_ = 0;
    RangeStats stats_{};
};

}  // namespace rangefile
