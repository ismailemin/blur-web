// Scenario suite for the T-005c fixed-step probe.
//
// Every scenario is a list of monotonic timestamps in integer microseconds. The
// first timestamp is the baseline; each following entry produces one rendered
// frame. Traces are generated with integer arithmetic only, so the same trace
// can be reproduced exactly by the independent Python model.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "fixed_step.h"
#include "sim_state.h"

namespace schedprobe {

struct Scenario {
    std::string name;
    std::string note;
    std::vector<std::int64_t> timestampsUs; // frames + 1 entries
    bool dropBacklog = true;
};

struct ScenarioSummary {
    std::string name;
    std::string note;
    bool dropBacklog = true;
    std::vector<FrameSample> samples;
    std::int64_t durationUs = 0;
    std::int64_t minDeltaUs = 0;
    std::int64_t maxDeltaUs = 0;
    std::int64_t totalTicks = 0;
    std::int64_t totalRequestedTicks = 0;
    std::int64_t maxTicksInFrame = 0;
    std::int64_t cappedFrames = 0;
    std::int64_t pausedFrames = 0;
    std::int64_t zeroTickFrames = 0;
    std::int64_t rewindFrames = 0;
    std::int64_t backlogDropFrames = 0;
    std::int64_t backlogDropTicks = 0;
    std::int64_t finalAccUnits = 0;
    std::int64_t finalAlphaNum = 0;
    std::int64_t finalAlphaDen = 0;
    std::string finalAlphaBits;
    SimState state;
    std::uint64_t stateHash = 0;
    std::uint64_t interpNum = 0;
    std::uint64_t interpDen = 0;
    std::uint64_t interpAlphaNum = 0;
    bool interpAlphaInRange = true;
    std::uint64_t renderHash = 0;
    bool accumulatorInRange = true;

    std::int64_t frames() const { return static_cast<std::int64_t>(samples.size()); }
};

// Trace helpers. All integer, all reproducible from the same formula in Python.
std::vector<std::int64_t> timestampsFromRate(std::int64_t frames, std::int64_t hz,
                                             std::int64_t usPerSecond = 1000000);
std::vector<std::int64_t> rateDeltas(std::int64_t frames, std::int64_t hz,
                                     std::int64_t usPerSecond = 1000000);
std::vector<std::int64_t> timestampsFromDeltas(const std::vector<std::int64_t>& deltasUs);
std::vector<std::int64_t> jitterDeltas(std::int64_t frames);

std::vector<Scenario> buildScenarios();

ScenarioSummary runScenario(const Scenario& scenario, const FixedStepConfig& baseConfig);
std::vector<ScenarioSummary> runSuite(const std::vector<Scenario>& scenarios,
                                      const FixedStepConfig& baseConfig);

// Serialises config + scenarios. `build` is the only part expected to differ
// between the native and wasm32 artefacts.
std::string suiteJson(const std::vector<ScenarioSummary>& summaries,
                      const FixedStepConfig& baseConfig, const std::string& target,
                      const std::string& compiler, const std::string& flags,
                      bool includeFrames);

std::string defaultSuiteJson(bool includeFrames);

// Full-suite self checks (alpha bounds, cap enforcement, frame-rate
// independence, determinism). Returns the number of failures and appends a
// human-readable report to *report when non-null.
int suiteSelfTest(std::string* report);

// Per-frame CSV for human inspection. Not part of the cross-implementation
// comparison.
std::string scenarioCsv(const ScenarioSummary& summary, const FixedStepConfig& baseConfig);

} // namespace schedprobe
