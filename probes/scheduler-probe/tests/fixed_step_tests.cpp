// Unit tests for the T-005c fixed-step probe. No test framework: exit status is
// the result and every failure prints file:line. Built by CMake and registered
// with CTest as `scheduler_fixed_step`.
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

#include "scenarios.h"

namespace {

int g_checks = 0;
int g_failures = 0;

#define CHECK(expr)                                                                  \
    do {                                                                             \
        ++g_checks;                                                                   \
        if (!(expr)) {                                                                \
            ++g_failures;                                                             \
            std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #expr);                \
        }                                                                             \
    } while (0)

#define CHECK_EQ(actual, expected)                                                    \
    do {                                                                              \
        ++g_checks;                                                                    \
        const std::int64_t valueA = static_cast<std::int64_t>(actual);                  \
        const std::int64_t valueB = static_cast<std::int64_t>(expected);                 \
        if (valueA != valueB) {                                                        \
            ++g_failures;                                                              \
            std::printf("FAIL %s:%d: %s == %s (%lld vs %lld)\n", __FILE__, __LINE__,    \
                        #actual, #expected, static_cast<long long>(valueA),              \
                        static_cast<long long>(valueB));                                \
        }                                                                              \
    } while (0)

using namespace schedprobe;

schedprobe::ScenarioSummary runTrace(const std::vector<std::int64_t>& timestamps,
                                     bool dropBacklog = true) {
    Scenario scenario;
    scenario.name = "unit";
    scenario.timestampsUs = timestamps;
    scenario.dropBacklog = dropBacklog;
    return runScenario(scenario, FixedStepConfig());
}

void test_baseline_frame() {
    FixedStepDriver driver;
    CHECK(!driver.hasBaseline());
    const FrameSample sample = driver.advanceTo(1000);
    CHECK_EQ(sample.dtUs, 0);
    CHECK_EQ(sample.ticks, 0);
    CHECK_EQ(sample.accUnits, 0);
    CHECK((sample.flags & kFrameBaseline) != 0u);
    CHECK((sample.flags & kFrameZeroTick) != 0u);
    CHECK(driver.hasBaseline());
    CHECK_EQ(driver.lastTimestampUs(), 1000);
    CHECK_EQ(driver.framesAdvanced(), 1);
}

void test_accumulator_unit_boundaries() {
    FixedStepDriver driver;
    const FrameSample first = driver.advanceBy(16666);
    CHECK_EQ(first.ticks, 0);
    CHECK_EQ(first.accUnits, 999960); // one microsecond short of a tick
    const FrameSample second = driver.advanceBy(1);
    CHECK_EQ(second.ticks, 1);
    CHECK_EQ(second.accUnits, 20); // 16667 us * 60 - 1000000

    FixedStepDriver exact;
    const FrameSample sample = exact.advanceBy(16667);
    CHECK_EQ(sample.requestedTicks, 1);
    CHECK_EQ(sample.ticks, 1);
    CHECK_EQ(sample.accUnits, 20);

    FixedStepDriver two;
    CHECK_EQ(two.advanceBy(33334).ticks, 2);
    CHECK_EQ(two.accumulatorUnits(), 40);
}

void test_cap_boundary() {
    FixedStepDriver driver;
    const FrameSample sample = driver.advanceBy(66667); // 4.00002 ticks
    CHECK_EQ(sample.requestedTicks, 4);
    CHECK_EQ(sample.ticks, 4);
    CHECK_EQ(sample.accUnits, 20);
    CHECK((sample.flags & kFrameCapped) == 0u); // exactly 4 is not capped
}

void test_cap_enforced_and_backlog_dropped() {
    FixedStepDriver driver;
    const FrameSample sample = driver.advanceBy(100000); // 6 requested
    CHECK_EQ(sample.requestedTicks, 6);
    CHECK_EQ(sample.ticks, 4);
    CHECK_EQ(sample.accUnits, 0);
    CHECK_EQ(sample.droppedTicks, 2);
    CHECK_EQ(sample.droppedUnits, 2000000);
    CHECK((sample.flags & kFrameCapped) != 0u);
    CHECK((sample.flags & kFrameBacklogDrop) != 0u);
}

void test_cap_without_backlog_drop() {
    FixedStepConfig config;
    config.dropBacklog = false;
    FixedStepDriver driver(config);
    const FrameSample sample = driver.advanceBy(100000);
    CHECK_EQ(sample.ticks, 4);
    CHECK_EQ(sample.accUnits, 2000000); // > one tick, kept by policy
    CHECK(alphaNumerator(sample, config) == alphaDenominator(config)); // saturates at 1
    const FrameSample catchUp = driver.advanceBy(0);
    CHECK_EQ(catchUp.ticks, 2);
    CHECK_EQ(catchUp.accUnits, 0);
}

void test_pause_threshold_is_strict() {
    FixedStepConfig config;
    FixedStepDriver atThreshold(config);
    const FrameSample bound = atThreshold.advanceBy(250000);
    CHECK((bound.flags & kFramePaused) == 0u);
    CHECK_EQ(bound.requestedTicks, 15);
    CHECK_EQ(bound.ticks, 4);

    FixedStepDriver above(config);
    const FrameSample paused = above.advanceBy(250001);
    CHECK((paused.flags & kFramePaused) != 0u);
    CHECK_EQ(paused.ticks, 0);
    CHECK_EQ(paused.accUnits, 0);
    CHECK_EQ(paused.requestedTicks, 0);
}

void test_pause_clears_pending_fraction() {
    FixedStepDriver driver;
    CHECK_EQ(driver.advanceBy(10000).accUnits, 600000);
    const FrameSample gap = driver.advanceBy(5000000);
    CHECK((gap.flags & kFramePaused) != 0u);
    CHECK_EQ(gap.dtUs, 5000000);
    CHECK_EQ(gap.accUnits, 0);
    CHECK_EQ(driver.accumulatorUnits(), 0);
    // The next frame advances normally from the emptied accumulator.
    const FrameSample after = driver.advanceBy(16667);
    CHECK_EQ(after.ticks, 1);
    CHECK_EQ(after.accUnits, 20);
}

void test_zero_delta() {
    FixedStepDriver driver;
    const FrameSample sample = driver.advanceBy(0);
    CHECK_EQ(sample.dtUs, 0);
    CHECK_EQ(sample.ticks, 0);
    CHECK((sample.flags & kFrameDeltaZero) != 0u);
    CHECK((sample.flags & kFrameZeroTick) != 0u);
}

void test_negative_delta_is_a_rewind() {
    FixedStepDriver driver;
    CHECK_EQ(driver.advanceBy(16667).ticks, 1);
    const FrameSample rewind = driver.advanceBy(-5000);
    CHECK((rewind.flags & kFrameDtRewind) != 0u);
    CHECK_EQ(rewind.dtUs, 0);
    CHECK_EQ(rewind.ticks, 0);
    CHECK_EQ(driver.accumulatorUnits(), 20); // unchanged by the bogus sample
    CHECK_EQ(driver.advanceBy(16667).ticks, 1);
}

void test_timestamp_rewind_resynchronises() {
    FixedStepDriver driver;
    driver.reset(1000);
    CHECK_EQ(driver.advanceTo(2000).dtUs, 1000);
    const FrameSample backwards = driver.advanceTo(500);
    CHECK((backwards.flags & kFrameDtRewind) != 0u);
    CHECK_EQ(backwards.dtUs, 0);
    CHECK_EQ(driver.lastTimestampUs(), 500);
    CHECK_EQ(driver.advanceTo(1500).dtUs, 1000); // baseline followed the rewind
}

void test_frame_rate_independence() {
    const ScenarioSummary sixty = runTrace(timestampsFromRate(600, 120));
    const ScenarioSummary thirty = runTrace(timestampsFromRate(150, 30));
    const ScenarioSummary twenty = runTrace(timestampsFromRate(100, 20));

    CHECK_EQ(sixty.durationUs, 5000000);
    CHECK_EQ(thirty.durationUs, 5000000);
    CHECK_EQ(twenty.durationUs, 5000000);
    CHECK_EQ(sixty.totalTicks, 300);
    CHECK_EQ(thirty.totalTicks, 300);
    CHECK_EQ(twenty.totalTicks, 300);
    CHECK(sixty.stateHash == thirty.stateHash);
    CHECK(sixty.stateHash == twenty.stateHash);
    CHECK(sixty.finalAlphaBits == thirty.finalAlphaBits);
    CHECK(sixty.finalAlphaBits == twenty.finalAlphaBits);
    CHECK_EQ(twenty.maxTicksInFrame, 3);
    CHECK_EQ(twenty.cappedFrames, 0);
}

void test_cap_boundary_15hz_is_measured_not_guessed() {
    // 4 ticks is 66666.67 us, so integer-microsecond timestamps of 66666/66667
    // us build a near-full-tick carry and every third frame requests 5 ticks.
    // The cap runs 4 and the ApplicationPC clamp discards the surplus. The
    // point of the test is that the loss is measured, never hidden.
    const ScenarioSummary summary = runTrace(timestampsFromRate(75, 15));
    CHECK_EQ(summary.durationUs, 5000000);
    CHECK_EQ(summary.totalRequestedTicks, 300);
    CHECK_EQ(summary.totalTicks, 275);
    CHECK_EQ(summary.backlogDropTicks, 25);
    CHECK_EQ(summary.cappedFrames, 25);
    CHECK_EQ(summary.maxTicksInFrame, 4);
    CHECK_EQ(summary.totalTicks + summary.backlogDropTicks, summary.totalRequestedTicks);
}

void test_frame_count_is_not_an_input() {
    // 100 ms as 2 frames of 50 ms vs 10 frames of 10 ms: same 6 ticks, same state.
    const ScenarioSummary coarse = runTrace(timestampsFromDeltas({50000, 50000}));
    std::vector<std::int64_t> fineDeltas;
    for (int i = 0; i < 10; ++i) {
        fineDeltas.push_back(10000);
    }
    const ScenarioSummary fine = runTrace(timestampsFromDeltas(fineDeltas));

    CHECK_EQ(coarse.frames(), 2);
    CHECK_EQ(fine.frames(), 10);
    CHECK_EQ(coarse.totalTicks, 6);
    CHECK_EQ(fine.totalTicks, 6);
    CHECK(coarse.stateHash == fine.stateHash);
    CHECK_EQ(coarse.finalAccUnits, 0);
    CHECK_EQ(fine.finalAccUnits, 0);
}

void test_one_tick_per_frame_matches_coarse_cadence() {
    std::vector<std::int64_t> deltas(300, 16667);
    const ScenarioSummary perTick = runTrace(timestampsFromDeltas(deltas));
    const ScenarioSummary coarse = runTrace(timestampsFromRate(600, 120));
    CHECK_EQ(perTick.totalTicks, 300);
    CHECK(perTick.stateHash == coarse.stateHash);
}

void test_cap_over_five_frames() {
    std::vector<std::int64_t> deltas(5, 200000);
    const ScenarioSummary summary = runTrace(timestampsFromDeltas(deltas));
    CHECK_EQ(summary.totalTicks, 20);
    CHECK_EQ(summary.maxTicksInFrame, 4);
    CHECK_EQ(summary.cappedFrames, 5);
    CHECK_EQ(summary.backlogDropFrames, 5);
    CHECK_EQ(summary.backlogDropTicks, 40);
}

void test_alpha_bounds_over_jitter() {
    Scenario scenario;
    scenario.name = "jitter";
    scenario.timestampsUs = timestampsFromDeltas(jitterDeltas(500));
    const FixedStepConfig config;
    const ScenarioSummary summary = runScenario(scenario, config);
    CHECK(summary.interpAlphaInRange);
    CHECK(summary.accumulatorInRange);
    for (const FrameSample& sample : summary.samples) {
        CHECK(sample.accUnits >= 0);
        CHECK(sample.accUnits < config.auPerStep());
        const std::int64_t numerator = alphaNumerator(sample, config);
        CHECK(numerator >= 0);
        CHECK(numerator <= config.auPerStep());
    }
    CHECK_EQ(summary.totalTicks, 239);
    CHECK_EQ(summary.durationUs, 3999000);
}

void test_hitch_and_tab_gap_details() {
    const std::vector<Scenario> scenarios = buildScenarios();
    std::vector<ScenarioSummary> summaries = runSuite(scenarios, FixedStepConfig());

    const ScenarioSummary* hitch = nullptr;
    const ScenarioSummary* gap = nullptr;
    for (const ScenarioSummary& summary : summaries) {
        if (summary.name == "hitch-250ms-400f") {
            hitch = &summary;
        } else if (summary.name == "tabgap-5s-400f") {
            gap = &summary;
        }
    }
    CHECK(hitch != nullptr);
    CHECK(gap != nullptr);
    if (hitch != nullptr) {
        CHECK_EQ(hitch->cappedFrames, 1);
        CHECK_EQ(hitch->pausedFrames, 0);
        CHECK(hitch->samples.size() > 200u);
        if (hitch->samples.size() > 200u) {
            const FrameSample& frame = hitch->samples[200];
            CHECK_EQ(frame.dtUs, 250000);
            CHECK_EQ(frame.requestedTicks, 15);
            CHECK_EQ(frame.ticks, 4);
            CHECK_EQ(frame.droppedTicks, 11);
            CHECK_EQ(frame.accUnits, 0);
        }
    }
    if (gap != nullptr) {
        CHECK_EQ(gap->pausedFrames, 1);
        CHECK(gap->samples.size() > 200u);
        if (gap->samples.size() > 200u) {
            const FrameSample& frame = gap->samples[200];
            CHECK_EQ(frame.dtUs, 5000000);
            CHECK_EQ(frame.ticks, 0);
            CHECK_EQ(frame.accUnits, 0);
            CHECK((frame.flags & kFramePaused) != 0u);
        }
    }
}

void test_determinism_bitwise() {
    const std::string first = defaultSuiteJson(true);
    const std::string second = defaultSuiteJson(true);
    CHECK(!first.empty());
    CHECK(first == second);
}

void test_config_validation() {
    const char* reason = "";
    CHECK(FixedStepConfig().valid(&reason));

    FixedStepConfig config;
    config.stepHz = 0;
    CHECK(!config.valid(&reason));
    config = FixedStepConfig();
    config.usPerSecond = 0;
    CHECK(!config.valid(&reason));
    config = FixedStepConfig();
    config.maxTicksPerFrame = 0;
    CHECK(!config.valid(&reason));
    config = FixedStepConfig();
    config.pauseThresholdUs = -1;
    CHECK(!config.valid(&reason));
    config = FixedStepConfig();
    config.stepHz = 5000;
    CHECK(!config.valid(&reason));
}

void test_pinned_state_hash() {
    // Pinned from the first verified native run. A change here means the state
    // model or the hash changed; it must then change in the Python reference too.
    const ScenarioSummary summary = runTrace(timestampsFromRate(600, 120));
    CHECK_EQ(summary.totalTicks, 300);
    CHECK_EQ(summary.state.pos, 398700ULL);
    CHECK_EQ(summary.state.vel, 2656ULL);
    CHECK(summary.stateHash == 0x7e04f9a197e01d8aULL);
    CHECK_EQ(summary.finalAccUnits, 0);
    CHECK(summary.finalAlphaBits == "0000000000000000");
}

} // namespace

int main() {
    test_baseline_frame();
    test_accumulator_unit_boundaries();
    test_cap_boundary();
    test_cap_enforced_and_backlog_dropped();
    test_cap_without_backlog_drop();
    test_pause_threshold_is_strict();
    test_pause_clears_pending_fraction();
    test_zero_delta();
    test_negative_delta_is_a_rewind();
    test_timestamp_rewind_resynchronises();
    test_frame_rate_independence();
    test_cap_boundary_15hz_is_measured_not_guessed();
    test_frame_count_is_not_an_input();
    test_one_tick_per_frame_matches_coarse_cadence();
    test_cap_over_five_frames();
    test_alpha_bounds_over_jitter();
    test_hitch_and_tab_gap_details();
    test_determinism_bitwise();
    test_config_validation();
    test_pinned_state_hash();

    std::printf("%d checks, %d failures\n", g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
}
