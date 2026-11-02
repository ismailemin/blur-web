// T-005c fixed-step driver — pure reference model, no engine headers.
//
// The rule implemented here is the decoupled update/render rule of
// upstream ApplicationPC.cpp:480-590 (accumulator, 1/60 tick, max 4 ticks,
// post-cap backlog clamp) plus the 0.25 s pause policy proposed in
// docs/work/analysis/t005-scheduler-design.md §4.3.
//
// Time base: integer microseconds only. The accumulator is an exact rational
// remainder, never a double, so native, wasm32 and an independent Python model
// can agree bit-for-bit. Floating point is used only to report alpha.
//
// Accumulator unit ("au"): 1/stepHz of a microsecond. With stepHz = 60 one tick
// is exactly usPerSecond au, so `acc % auPerStep()` is the exact fractional
// part of a tick as an integer.
#pragma once

#include <cstdint>
#include <string>

namespace schedprobe {

// Per-frame flags. Bits are stable and are emitted in the probe JSON.
enum FrameFlags : unsigned {
    kFrameTick = 1u << 0,        // at least one simulation tick ran
    kFrameZeroTick = 1u << 1,    // no simulation tick ran
    kFrameCapped = 1u << 2,      // requested ticks exceeded maxTicksPerFrame
    kFrameBacklogDrop = 1u << 3, // post-cap clamp cleared the accumulator
    kFramePaused = 1u << 4,      // delta exceeded pauseThresholdUs; accumulator dropped
    kFrameDtRewind = 1u << 5,    // negative delta; treated as zero
    kFrameDeltaZero = 1u << 6,   // delta was exactly zero
    kFrameBaseline = 1u << 7,    // first sample: baseline established, no delta consumed
};

struct FixedStepConfig {
    std::int64_t stepHz = 60;              // simulation steps per second
    std::int64_t usPerSecond = 1000000;    // microseconds per second
    std::int64_t maxTicksPerFrame = 4;     // ApplicationPC.cpp:518-519
    std::int64_t pauseThresholdUs = 250000; // design §4.3 proposal; not in the PC loop
    bool dropBacklog = true;               // ApplicationPC.cpp:521-522

    // Accumulator scaling. One tick == auPerStep() units and one microsecond
    // == auPerUs() units, so a delta is converted exactly with a multiply.
    std::int64_t auPerUs() const { return stepHz; }
    std::int64_t auPerStep() const { return usPerSecond; }

    // Rejects configurations that would make the integer model meaningless.
    // Returns false and sets *reason when invalid.
    bool valid(const char** reason) const;
};

struct FrameSample {
    std::int64_t dtUs = 0;            // delta consumed, after rewind clamping
    std::int64_t requestedTicks = 0;  // floor(accumulator / tick) before the cap
    std::int64_t ticks = 0;           // ticks actually executed
    std::int64_t accUnits = 0;        // accumulator after this frame, in au
    std::int64_t droppedUnits = 0;    // au discarded by the post-cap clamp
    std::int64_t droppedTicks = 0;    // droppedUnits expressed in ticks
    unsigned flags = 0;
};

// Exact alpha as an integer fraction: alphaNumerator / alphaDenominator.
// alphaDenominator is auPerStep(). The numerator is clamped to the denominator
// so a configuration with dropBacklog=false still reports alpha in [0,1].
std::int64_t alphaNumerator(const FrameSample& sample, const FixedStepConfig& config);
std::int64_t alphaDenominator(const FixedStepConfig& config);

// IEEE-754 bit pattern of `value` as 16 lowercase hex digits, without a prefix.
// Used so native/wasm/Python can compare alpha exactly instead of comparing
// locale- or libc-dependent decimal text.
std::string doubleBitsHex(double value);

class FixedStepDriver {
public:
    explicit FixedStepDriver(FixedStepConfig config = FixedStepConfig());

    // Drops the accumulator and makes `nowUs` the monotonic baseline.
    void reset(std::int64_t nowUs);

    // Monotonic timestamp entry point. The first call after construction or
    // reset only establishes the baseline and reports kFrameBaseline.
    FrameSample advanceTo(std::int64_t nowUs);

    // Explicit-delta entry point for trace-driven tests. Does not touch the
    // timestamp baseline, so callers use either advanceTo() or advanceBy().
    FrameSample advanceBy(std::int64_t dtUs);

    const FixedStepConfig& config() const { return config_; }
    std::int64_t accumulatorUnits() const { return accumulatorUnits_; }
    std::int64_t lastTimestampUs() const { return lastTimestampUs_; }
    bool hasBaseline() const { return hasBaseline_; }
    std::int64_t framesAdvanced() const { return framesAdvanced_; }

private:
    FrameSample step(std::int64_t dtUs);

    FixedStepConfig config_;
    std::int64_t accumulatorUnits_ = 0;
    std::int64_t lastTimestampUs_ = 0;
    std::int64_t framesAdvanced_ = 0;
    bool hasBaseline_ = false;
};

} // namespace schedprobe
