#include "pak_reader.h"
#include <cstdint>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>

int main(int argc, char** argv) {
    if (argc != 2) { std::cerr << "Usage: pak_inspect <installed-file.pak>\n"; return 2; }
    std::ifstream input(argv[1], std::ios::binary | std::ios::ate);
    if (!input) { std::cerr << "Cannot open input\n"; return 2; }
    const auto end = input.tellg();
    if (end < 0) return 2;
    const uint64_t size = static_cast<uint64_t>(end);
    uint64_t wanted = size < 64 ? size : 64;
    for (unsigned attempt = 0; attempt < 8; ++attempt) {
        if (wanted > 64*1024*1024 || wanted > size) { std::cerr << "Invalid prefix request\n"; return 2; }
        std::vector<unsigned char> bytes(static_cast<size_t>(wanted));
        input.clear(); input.seekg(0);
        input.read(reinterpret_cast<char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
        if (static_cast<size_t>(input.gcount()) != bytes.size()) { std::cerr << "Short read\n"; return 2; }
        char* raw = pak_inspect(bytes.data(), bytes.size(), static_cast<double>(size));
        if (!raw) { std::cerr << "Allocation failed\n"; return 2; }
        const std::string report(raw); pak_free(raw);
        const std::string field = "\"requiredBytes\":";
        const size_t position = report.find(field);
        if (report.find("\"status\":\"need_more\"") != std::string::npos && position != std::string::npos) {
            const auto next = std::stoull(report.substr(position+field.size()));
            if (next <= wanted) { std::cerr << "Nonprogressing request\n"; return 2; }
            wanted = next;
            continue;
        }
        std::cout << report << '\n';
        return report.find("\"status\":\"ok\"") != std::string::npos ? 0 : 1;
    }
    std::cerr << "Too many prefix requests\n";
    return 2;
}
