#include "texture_reader.h"
#include <fstream>
#include <iostream>
#include <string>
#include <vector>

int main(int argc, char** argv) {
    if (argc < 2 || argc > 3 || (argc == 3 && std::string(argv[2]) != "--raw")) { std::cerr << "Usage: texture_inspect decoded-texture-file [--raw]\n"; return 2; }
    std::ifstream input(argv[1], std::ios::binary | std::ios::ate);
    if (!input || input.tellg() < 0 || input.tellg() > 64 * 1024 * 1024) {
        std::cerr << "Cannot read model or input exceeds 64 MiB\n"; return 2;
    }
    const size_t size = static_cast<size_t>(input.tellg());
    input.seekg(0);
    std::vector<unsigned char> data(size);
    if (size && !input.read(reinterpret_cast<char*>(data.data()), static_cast<std::streamsize>(size))) return 2;
    char* json = argc == 3 ? texture_raw_inspect(data.data(), data.size()) : texture_inspect(data.data(), data.size());
    if (!json) return 3;
    const std::string result(json);
    texture_free(json);
    std::cout << result << '\n';
    return result.find("\"status\":\"ok\"") != std::string::npos ? 0 : 1;
}

