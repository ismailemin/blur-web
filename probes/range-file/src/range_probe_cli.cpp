// Standalone range-file probe CLI.
//   range_probe pak   <path> [--window N]
//   range_probe level <path> [--window N]
// It prints one JSON object and never writes to the input.

#include "byte_source.h"
#include "level_index_range.h"
#include "pak_index_range.h"
#include "range_file.h"

#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <stdexcept>
#include <string>

namespace {

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

size_t parseWindow(const std::string& text) {
    size_t used = 0;
    unsigned long long value = 0;
    try {
        value = std::stoull(text, &used, 10);
    } catch (const std::exception&) {
        throw std::runtime_error("Invalid --window value: " + text);
    }
    if (used != text.size() || value == 0) throw std::runtime_error("Invalid --window value: " + text);
    if (value > rangefile::RangeFile::kMaxWindow)
        throw std::runtime_error("--window exceeds probe maximum");
    return static_cast<size_t>(value);
}

}  // namespace

int main(int argc, char** argv) {
    try {
        if (argc < 3) {
            std::cerr << "Usage: range_probe <pak|level> <path> [--window N]\n";
            return 2;
        }
        const std::string mode = argv[1];
        const std::string path = argv[2];
        size_t window = rangefile::RangeFile::kDefaultWindow;
        for (int i = 3; i < argc; ++i) {
            const std::string option = argv[i];
            if (option == "--window" && i + 1 < argc) {
                window = parseWindow(argv[++i]);
            } else {
                throw std::runtime_error("Unknown argument: " + option);
            }
        }

        rangefile::FileByteSource source(path);
        rangefile::RangeFile file(source, window);
        std::string json;
        if (mode == "pak") {
            const rangefile::PakIndex index = rangefile::parse_pak_index(file);
            json = rangefile::pak_index_json(index, file.stats());
        } else if (mode == "level") {
            const rangefile::LevelIndex index = rangefile::parse_level_index(file);
            json = rangefile::level_index_json(index, file.stats());
        } else {
            throw std::runtime_error("Unknown mode: " + mode);
        }
        std::cout << json << '\n';
        return 0;
    } catch (const std::exception& error) {
        std::cout << "{\"status\":\"error\",\"error\":" << quote(error.what()) << "}\n";
        return 1;
    } catch (...) {
        std::cout << "{\"status\":\"error\",\"error\":\"Unexpected range probe failure\"}\n";
        return 1;
    }
}
