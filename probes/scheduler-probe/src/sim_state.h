// Deterministic integer simulation state used only to prove that simulation
// state depends on tick count, not on rendered frame count.
//
// Deliberately contains no floating point and no division: every operation is
// unsigned 64-bit arithmetic with defined wraparound, so native, wasm32 and the
// independent Python model produce identical values.
#pragma once

#include <cstddef>
#include <cstdint>
#include <string>

namespace schedprobe {

struct SimState {
    std::uint64_t pos = 0;
    std::uint64_t vel = 0;
};

// One simulation tick. `tickIndex` is 1-based. Pure function of
// (state, tickIndex), so a run of N ticks always ends in the same state.
void simStep(SimState& state, std::uint64_t tickIndex);

// FNV-1a 64 over explicit little-endian bytes (no memcpy, no host endianness).
std::uint64_t fnv1a64Seed();
std::uint64_t fnv1a64Mix(std::uint64_t hash, std::uint64_t value);
std::uint64_t hashSimState(const SimState& state);
std::uint64_t hashU64(std::uint64_t value);

std::string hexU64(std::uint64_t value);

} // namespace schedprobe
