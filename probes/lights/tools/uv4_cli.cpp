// CLI for the four-component UV0 copy of the committed Scene reader.
//
// Usage: uv4_inspect <decoded-model-file>
//
// Emits the same JSON as the committed scene_inspect plus "uv0xyzw" (four
// floats per vertex). No other behaviour is added.
#include "scene_reader.h"

#include <cstring>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>

int main(int argc, char** argv) {
    if (argc != 2) {
        std::cerr << "Usage: uv4_inspect decoded-model-file\n";
        return 2;
    }
    std::ifstream input(argv[1], std::ios::binary | std::ios::ate);
    if (!input || input.tellg() < 0 || input.tellg() > 64 * 1024 * 1024) {
        std::cerr << "Cannot read model or input exceeds 64 MiB\n";
        return 2;
    }
    const size_t size = static_cast<size_t>(input.tellg());
    input.seekg(0);
    std::vector<unsigned char> data(size);
    if (size && !input.read(reinterpret_cast<char*>(data.data()), static_cast<std::streamsize>(size))) return 2;
    char* json = scene_inspect(data.data(), data.size());
    if (!json) return 3;
    const std::string result(json);
    scene_free(json);
    std::cout << result << '\n';
    return result.find("\"status\":\"ok\"") != std::string::npos ? 0 : 1;
}
