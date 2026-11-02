#include "sim_state.h"

#include <cstdio>
#include <string>

namespace schedprobe {

namespace {

// Fixed accel table, 16 entries, no sign: keeps the whole state unsigned.
const std::uint64_t kAcceleration[16] = {
    1, 2, 3, 5, 8, 13, 21, 34, 21, 13, 8, 5, 3, 2, 1, 0,
};

} // namespace

void simStep(SimState& state, std::uint64_t tickIndex) {
    state.vel += kAcceleration[tickIndex & 15u];
    state.pos += state.vel;
}

std::uint64_t fnv1a64Seed() {
    return 0xcbf29ce484222325ULL;
}

std::uint64_t fnv1a64Mix(std::uint64_t hash, std::uint64_t value) {
    for (int i = 0; i < 8; ++i) {
        hash ^= (value >> (8 * i)) & 0xffULL;
        hash *= 0x100000001b3ULL;
    }
    return hash;
}

std::uint64_t hashSimState(const SimState& state) {
    std::uint64_t hash = fnv1a64Seed();
    hash = fnv1a64Mix(hash, state.pos);
    hash = fnv1a64Mix(hash, state.vel);
    return hash;
}

std::uint64_t hashU64(std::uint64_t value) {
    return fnv1a64Mix(fnv1a64Seed(), value);
}

std::string hexU64(std::uint64_t value) {
    char buffer[24];
    std::snprintf(buffer, sizeof(buffer), "0x%016llx", static_cast<unsigned long long>(value));
    return std::string(buffer);
}

} // namespace schedprobe
