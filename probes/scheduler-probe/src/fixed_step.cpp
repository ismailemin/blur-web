#include "fixed_step.h"

#include <cassert>
#include <cstdio>
#include <cstring>

namespace schedprobe {

bool FixedStepConfig::valid(const char** reason) const {
    const char* local = "";
    if (stepHz <= 0 || stepHz > 1000) {
        local = "stepHz must be in (0, 1000]";
    } else if (usPerSecond <= 0 || usPerSecond > 1000000000) {
        local = "usPerSecond must be in (0, 1e9]";
    } else if (maxTicksPerFrame <= 0 || maxTicksPerFrame > 1024) {
        local = "maxTicksPerFrame must be in [1, 1024]";
    } else if (pauseThresholdUs < 0) {
        local = "pauseThresholdUs must be non-negative";
    } else if (pauseThresholdUs > 1000000000) {
        local = "pauseThresholdUs must be at most 1e9 (1000 s)";
    }
    if (reason != nullptr) {
        *reason = local;
    }
    return local[0] == '\0';
}

std::int64_t alphaNumerator(const FrameSample& sample, const FixedStepConfig& config) {
    const std::int64_t step = config.auPerStep();
    return sample.accUnits > step ? step : sample.accUnits;
}

std::int64_t alphaDenominator(const FixedStepConfig& config) {
    return config.auPerStep();
}

std::string doubleBitsHex(double value) {
    std::uint64_t bits = 0;
    static_assert(sizeof(bits) == sizeof(value), "double must be 64-bit for this probe");
    std::memcpy(&bits, &value, sizeof(bits));
    char buffer[24];
    std::snprintf(buffer, sizeof(buffer), "%016llx", static_cast<unsigned long long>(bits));
    return std::string(buffer);
}

FixedStepDriver::FixedStepDriver(FixedStepConfig config) : config_(config) {
    const char* reason = "";
    const bool ok = config_.valid(&reason);
    // Both are only observed by the debug assert; the casts keep release builds
    // warning-free under MSVC /W4.
    assert(ok && "invalid FixedStepConfig");
    (void)ok;
    (void)reason;
}

void FixedStepDriver::reset(std::int64_t nowUs) {
    accumulatorUnits_ = 0;
    lastTimestampUs_ = nowUs;
    framesAdvanced_ = 0;
    hasBaseline_ = true;
}

FrameSample FixedStepDriver::advanceTo(std::int64_t nowUs) {
    if (!hasBaseline_) {
        hasBaseline_ = true;
        lastTimestampUs_ = nowUs;
        accumulatorUnits_ = 0;
        ++framesAdvanced_;
        FrameSample sample;
        sample.flags = kFrameBaseline | kFrameDeltaZero | kFrameZeroTick;
        sample.accUnits = accumulatorUnits_;
        return sample;
    }
    const std::int64_t dtUs = nowUs - lastTimestampUs_;
    lastTimestampUs_ = nowUs;
    return step(dtUs);
}

FrameSample FixedStepDriver::advanceBy(std::int64_t dtUs) {
    return step(dtUs);
}

// Mirrors ApplicationPC.cpp:508-529:
//   ticks = floor(accum / tick); cap at 4; accum -= ticks * tick;
//   if (accum >= tick) accum = 0;
// with the integer accumulator exact in au. The pause rule from design §4.3
// runs before the accumulation and never consumes the delta.
FrameSample FixedStepDriver::step(std::int64_t dtUs) {
    FrameSample sample;
    std::int64_t effectiveDtUs = dtUs;

    if (effectiveDtUs < 0) {
        // A monotonic clock must not go backwards. Resynchronise instead of
        // rewinding the simulation; the sample is recorded, not swallowed.
        sample.flags |= kFrameDtRewind;
        effectiveDtUs = 0;
    }
    if (effectiveDtUs == 0) {
        sample.flags |= kFrameDeltaZero;
    }
    sample.dtUs = effectiveDtUs;

    if (effectiveDtUs > config_.pauseThresholdUs) {
        // Tab throttled, devtools paused or a stalled frame: treat it as a
        // pause and do not fast-forward. The delta is discarded entirely.
        sample.flags |= kFramePaused;
        accumulatorUnits_ = 0;
    } else {
        accumulatorUnits_ += effectiveDtUs * config_.auPerUs();
    }

    const std::int64_t stepUnits = config_.auPerStep();
    sample.requestedTicks = accumulatorUnits_ / stepUnits;

    std::int64_t ticks = sample.requestedTicks;
    if (ticks > config_.maxTicksPerFrame) {
        ticks = config_.maxTicksPerFrame;
        sample.flags |= kFrameCapped;
    }

    if (ticks > 0) {
        accumulatorUnits_ -= ticks * stepUnits;
        if (config_.dropBacklog && accumulatorUnits_ >= stepUnits) {
            // ApplicationPC.cpp:521-522. Without this clamp a display slower
            // than 15 Hz accumulates a permanent backlog (spiral of death).
            sample.droppedUnits = accumulatorUnits_;
            sample.droppedTicks = accumulatorUnits_ / stepUnits;
            accumulatorUnits_ = 0;
            sample.flags |= kFrameBacklogDrop;
        }
        sample.flags |= kFrameTick;
    } else {
        sample.flags |= kFrameZeroTick;
    }

    assert(accumulatorUnits_ >= 0 && "accumulator must never be negative");
    assert((accumulatorUnits_ < stepUnits || !config_.dropBacklog) &&
           "clamped accumulator must stay below one tick");

    sample.ticks = ticks;
    sample.accUnits = accumulatorUnits_;
    ++framesAdvanced_;
    return sample;
}

} // namespace schedprobe
