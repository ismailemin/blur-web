#pragma once
// T-005b slice 1 probe: byte sources behind a range-only reader.
// No engine header is included here. This file is C++17 and compiles for
// Windows x64 and wasm32 (Emscripten NODERAWFS).

#include <cstddef>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace rangefile {

// A byte source answers exactly one question: "copy `length` bytes at
// `offset`". It must either copy the complete range or throw. A partial copy,
// a short read or a zero fill is a hard error.
class ByteSource {
public:
    virtual ~ByteSource() = default;
    virtual uint64_t size() const = 0;
    virtual void read(uint64_t offset, uint8_t* destination, size_t length) = 0;
    virtual const char* kind() const = 0;
};

// Read-only view of a file on the host filesystem. The file is never mapped or
// loaded as a whole; every read seeks to the requested offset.
class FileByteSource final : public ByteSource {
public:
    explicit FileByteSource(const std::string& path) : path_(path) {
        input_.open(path, std::ios::binary);
        if (!input_) throw std::runtime_error("Cannot open input file: " + path);
        input_.seekg(0, std::ios::end);
        const std::streamoff end = input_.tellg();
        if (end < 0) throw std::runtime_error("Cannot determine input size: " + path);
        size_ = static_cast<uint64_t>(end);
        input_.seekg(0, std::ios::beg);
        if (!input_) throw std::runtime_error("Cannot seek input file: " + path);
    }

    uint64_t size() const override { return size_; }
    const char* kind() const override { return "file"; }

    void read(uint64_t offset, uint8_t* destination, size_t length) override {
        if (!destination && length) throw std::runtime_error("Null read destination");
        if (offset > size_ || length > size_ - offset) {
            throw std::runtime_error("File source range outside file: offset " +
                                     std::to_string(offset) + " length " +
                                     std::to_string(length) + " size " +
                                     std::to_string(size_));
        }
        input_.clear();
        input_.seekg(static_cast<std::streamoff>(offset), std::ios::beg);
        if (!input_) throw std::runtime_error("Cannot seek input file to offset " + std::to_string(offset));
        input_.read(reinterpret_cast<char*>(destination), static_cast<std::streamsize>(length));
        const std::streamsize got = input_.gcount();
        if (got != static_cast<std::streamsize>(length)) {
            throw std::runtime_error("Short file read at offset " + std::to_string(offset) +
                                     ": requested " + std::to_string(length) + " got " +
                                     std::to_string(static_cast<uint64_t>(got)));
        }
    }

private:
    std::string path_;
    std::ifstream input_;
    uint64_t size_ = 0;
};

// In-memory source used by the unit tests. Its bytes are the test fixture, not
// a production fallback.
class MemoryByteSource final : public ByteSource {
public:
    explicit MemoryByteSource(std::vector<uint8_t> bytes) : bytes_(std::move(bytes)) {}

    uint64_t size() const override { return bytes_.size(); }
    const char* kind() const override { return "memory"; }

    void read(uint64_t offset, uint8_t* destination, size_t length) override {
        if (!destination && length) throw std::runtime_error("Null read destination");
        if (offset > bytes_.size() || length > bytes_.size() - offset) {
            throw std::runtime_error("Memory source range outside buffer: offset " +
                                     std::to_string(offset) + " length " +
                                     std::to_string(length) + " size " +
                                     std::to_string(bytes_.size()));
        }
        if (length) std::memcpy(destination, bytes_.data() + offset, length);
    }

    const std::vector<uint8_t>& bytes() const { return bytes_; }

private:
    std::vector<uint8_t> bytes_;
};

}  // namespace rangefile
