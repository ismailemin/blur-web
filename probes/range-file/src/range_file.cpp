#include "range_file.h"

#include <algorithm>
#include <stdexcept>
#include <string>

namespace rangefile {
namespace {

[[noreturn]] void fail(const std::string& message) { throw std::runtime_error(message); }

std::string describe(uint64_t offset, uint64_t length, uint64_t size) {
    return "offset " + std::to_string(offset) + " length " + std::to_string(length) +
           " source size " + std::to_string(size);
}

}  // namespace

RangeFile::RangeFile(ByteSource& source, size_t windowBytes)
    : source_(source), size_(source.size()), window_(windowBytes) {
    if (!window_) fail("Range window must be at least 1 byte");
    if (window_ > kMaxWindow)
        fail("Range window " + std::to_string(window_) + " exceeds probe maximum " +
             std::to_string(static_cast<uint64_t>(kMaxWindow)));
    stats_.sourceSize = size_;
    stats_.windowBytes = static_cast<uint64_t>(window_);
}

void RangeFile::checkRange(uint64_t offset, uint64_t length) const {
    if (!length) fail("Range length must be at least 1: " + describe(offset, length, size_));
    if (offset > size_)
        fail("Range offset exceeds source size: " + describe(offset, length, size_));
    // Subtraction form: length > size - offset cannot overflow, while
    // offset + length could.
    if (length > size_ - offset)
        fail("Range underflows source: " + describe(offset, length, size_) + " (max length " +
             std::to_string(size_ - offset) + ")");
}

void RangeFile::seek(uint64_t position) {
    if (position > size_)
        fail("Seek position " + std::to_string(position) + " exceeds source size " +
             std::to_string(size_));
    position_ = position;
}

void RangeFile::skip(uint64_t bytes) {
    if (bytes > size_ - position_)
        fail("Skip of " + std::to_string(bytes) + " bytes from " + std::to_string(position_) +
             " underflows source size " + std::to_string(size_));
    position_ += bytes;
}

void RangeFile::readAt(uint64_t offset, void* destination, size_t length) {
    checkRange(offset, static_cast<uint64_t>(length));
    if (!destination) fail("Null read destination: " + describe(offset, length, size_));

    uint8_t* cursor = static_cast<uint8_t*>(destination);
    uint64_t remainingBytes = length;
    while (remainingBytes) {
        const size_t chunk = static_cast<size_t>(
            std::min<uint64_t>(remainingBytes, static_cast<uint64_t>(window_)));
        source_.read(offset, cursor, chunk);
        ++stats_.sourceRequests;
        stats_.bytesRead += chunk;
        stats_.largestSourceRequest = std::max(stats_.largestSourceRequest,
                                               static_cast<uint64_t>(chunk));
        offset += chunk;
        cursor += chunk;
        remainingBytes -= chunk;
    }
}

void RangeFile::read(void* destination, size_t length) {
    readAt(position_, destination, length);
    position_ += length;
}

uint8_t RangeFile::u8() {
    uint8_t value = 0;
    read(&value, 1);
    return value;
}

uint16_t RangeFile::u16le() {
    uint8_t bytes[2]{};
    read(bytes, sizeof bytes);
    return static_cast<uint16_t>(static_cast<uint16_t>(bytes[0]) |
                                 static_cast<uint16_t>(bytes[1]) << 8);
}

uint32_t RangeFile::u32le() {
    uint8_t bytes[4]{};
    read(bytes, sizeof bytes);
    return static_cast<uint32_t>(bytes[0]) | static_cast<uint32_t>(bytes[1]) << 8 |
           static_cast<uint32_t>(bytes[2]) << 16 | static_cast<uint32_t>(bytes[3]) << 24;
}

uint64_t RangeFile::u64le() {
    uint8_t bytes[8]{};
    read(bytes, sizeof bytes);
    uint64_t value = 0;
    for (unsigned i = 0; i < 8; ++i) value |= static_cast<uint64_t>(bytes[i]) << (i * 8);
    return value;
}

}  // namespace rangefile
