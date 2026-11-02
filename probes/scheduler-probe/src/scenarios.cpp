#include "scenarios.h"

#include <algorithm>
#include <cstdio>

#include "build_info.h"
#include "json_out.h"

namespace schedprobe {

namespace {

const std::int64_t kJitterTable[16] = {
    7000, 7500, 8000, 8500, 9000, 9500, 8500, 7500,
    6500, 7000, 8000, 9000, 10000, 8500, 7500, 6000,
};

std::vector<std::int64_t> collectTicks(const ScenarioSummary& summary) {
    std::vector<std::int64_t> values;
    values.reserve(summary.samples.size());
    for (const FrameSample& sample : summary.samples) {
        values.push_back(sample.ticks);
    }
    return values;
}

std::vector<std::int64_t> collectAccUnits(const ScenarioSummary& summary) {
    std::vector<std::int64_t> values;
    values.reserve(summary.samples.size());
    for (const FrameSample& sample : summary.samples) {
        values.push_back(sample.accUnits);
    }
    return values;
}

std::vector<std::int64_t> collectDeltas(const ScenarioSummary& summary) {
    std::vector<std::int64_t> values;
    values.reserve(summary.samples.size());
    for (const FrameSample& sample : summary.samples) {
        values.push_back(sample.dtUs);
    }
    return values;
}

std::vector<unsigned> collectFlags(const ScenarioSummary& summary) {
    std::vector<unsigned> values;
    values.reserve(summary.samples.size());
    for (const FrameSample& sample : summary.samples) {
        values.push_back(sample.flags);
    }
    return values;
}

const ScenarioSummary* findScenario(const std::vector<ScenarioSummary>& summaries,
                                    const std::string& name) {
    for (const ScenarioSummary& summary : summaries) {
        if (summary.name == name) {
            return &summary;
        }
    }
    return nullptr;
}

void appendCheck(std::string* report, int& failures, bool ok, const std::string& message) {
    if (!ok) {
        ++failures;
    }
    if (report != nullptr) {
        report->append(ok ? "ok: " : "FAIL: ");
        report->append(message);
        report->append("\n");
    }
}

} // namespace

std::vector<std::int64_t> timestampsFromRate(std::int64_t frames, std::int64_t hz,
                                             std::int64_t usPerSecond) {
    std::vector<std::int64_t> timestamps;
    timestamps.resize(static_cast<std::size_t>(frames) + 1u);
    for (std::int64_t i = 0; i <= frames; ++i) {
        timestamps[static_cast<std::size_t>(i)] = (i * usPerSecond) / hz;
    }
    return timestamps;
}

std::vector<std::int64_t> rateDeltas(std::int64_t frames, std::int64_t hz,
                                     std::int64_t usPerSecond) {
    const std::vector<std::int64_t> timestamps = timestampsFromRate(frames, hz, usPerSecond);
    std::vector<std::int64_t> deltas;
    deltas.reserve(static_cast<std::size_t>(frames));
    for (std::int64_t i = 0; i < frames; ++i) {
        deltas.push_back(timestamps[static_cast<std::size_t>(i) + 1u] -
                         timestamps[static_cast<std::size_t>(i)]);
    }
    return deltas;
}

std::vector<std::int64_t> timestampsFromDeltas(const std::vector<std::int64_t>& deltasUs) {
    std::vector<std::int64_t> timestamps;
    timestamps.reserve(deltasUs.size() + 1u);
    timestamps.push_back(0);
    std::int64_t now = 0;
    for (const std::int64_t delta : deltasUs) {
        now += delta;
        timestamps.push_back(now);
    }
    return timestamps;
}

std::vector<std::int64_t> jitterDeltas(std::int64_t frames) {
    std::vector<std::int64_t> deltas;
    deltas.reserve(static_cast<std::size_t>(frames));
    for (std::int64_t i = 0; i < frames; ++i) {
        deltas.push_back(kJitterTable[static_cast<std::size_t>(i) & 15u]);
    }
    return deltas;
}

std::vector<Scenario> buildScenarios() {
    std::vector<Scenario> scenarios;

    {
        Scenario scenario;
        scenario.name = "hz144-600f";
        scenario.note = "600 rendered frames at 144 Hz; 600 deltas of 6944/6945 us";
        scenario.timestampsUs = timestampsFromRate(600, 144);
        scenarios.push_back(scenario);
    }
    {
        Scenario scenario;
        scenario.name = "hz30-300f";
        scenario.note = "300 rendered frames at 30 Hz; deltas of 33333/33334 us";
        scenario.timestampsUs = timestampsFromRate(300, 30);
        scenarios.push_back(scenario);
    }
    {
        Scenario scenario;
        scenario.name = "hitch-250ms-400f";
        scenario.note = "400 frames at 144 Hz with frame 200's delta replaced by exactly "
                        "250000 us (pause threshold boundary, not a pause)";
        std::vector<std::int64_t> deltas = rateDeltas(400, 144);
        deltas[200] = 250000;
        scenario.timestampsUs = timestampsFromDeltas(deltas);
        scenarios.push_back(scenario);
    }
    {
        Scenario scenario;
        scenario.name = "tabgap-5s-400f";
        scenario.note = "400 frames at 144 Hz with frame 200's delta replaced by 5000000 us "
                        "(background tab: pause rule must drop the accumulator)";
        std::vector<std::int64_t> deltas = rateDeltas(400, 144);
        deltas[200] = 5000000;
        scenario.timestampsUs = timestampsFromDeltas(deltas);
        scenarios.push_back(scenario);
    }
    {
        Scenario scenario;
        scenario.name = "jitter-8ms-500f";
        scenario.note = "500 frames of a fixed 16-entry delta pattern; a full 16-frame "
                        "cycle averages exactly 8000 us and the 500-frame total is 3999000 us";
        scenario.timestampsUs = timestampsFromDeltas(jitterDeltas(500));
        scenarios.push_back(scenario);
    }
    {
        Scenario scenario;
        scenario.name = "equal5s-600f";
        scenario.note = "the same 5 s of simulated time delivered as 600 frames (120 Hz)";
        scenario.timestampsUs = timestampsFromRate(600, 120);
        scenarios.push_back(scenario);
    }
    {
        Scenario scenario;
        scenario.name = "equal5s-150f";
        scenario.note = "the same 5 s of simulated time delivered as 150 frames (30 Hz)";
        scenario.timestampsUs = timestampsFromRate(150, 30);
        scenarios.push_back(scenario);
    }
    {
        Scenario scenario;
        scenario.name = "equal5s-100f";
        scenario.note = "the same 5 s of simulated time delivered as 100 frames (20 Hz); "
                        "3 ticks per frame, clear of the 4-tick cap";
        scenario.timestampsUs = timestampsFromRate(100, 20);
        scenarios.push_back(scenario);
    }
    {
        Scenario scenario;
        scenario.name = "capboundary-15hz-75f";
        scenario.note = "5 s at 15 Hz. 4 ticks is 66666.67 us, so integer-microsecond "
                        "timestamps of 66666/66667 us accumulate a near-full-tick carry; "
                        "every third frame requests 5 ticks, the cap runs 4 and the "
                        "ApplicationPC backlog clamp discards 1. Executed + dropped still "
                        "equals requested; the lost ticks are the measured cost of the cap.";
        scenario.timestampsUs = timestampsFromRate(75, 15);
        scenarios.push_back(scenario);
    }
    {
        Scenario scenario;
        scenario.name = "keepbacklog-200ms-5f";
        scenario.note = "dropBacklog=false policy comparison: 5 frames of 200000 us keep the "
                        "unconsumed backlog, so alpha saturates at 1 and the accumulator grows";
        std::vector<std::int64_t> deltas(5, 200000);
        scenario.timestampsUs = timestampsFromDeltas(deltas);
        scenario.dropBacklog = false;
        scenarios.push_back(scenario);
    }

    return scenarios;
}

ScenarioSummary runScenario(const Scenario& scenario, const FixedStepConfig& baseConfig) {
    ScenarioSummary summary;
    summary.name = scenario.name;
    summary.note = scenario.note;
    summary.dropBacklog = scenario.dropBacklog;

    FixedStepConfig config = baseConfig;
    config.dropBacklog = scenario.dropBacklog;

    FixedStepDriver driver(config);
    SimState state;
    SimState previous;
    std::uint64_t tickIndex = 0;

    const std::size_t frameCount =
        scenario.timestampsUs.empty() ? 0u : scenario.timestampsUs.size() - 1u;
    summary.samples.reserve(frameCount);

    if (frameCount != 0u) {
        driver.reset(scenario.timestampsUs.front());
    }

    for (std::size_t i = 1; i <= frameCount; ++i) {
        const FrameSample sample = driver.advanceTo(scenario.timestampsUs[i]);
        summary.samples.push_back(sample);

        for (std::int64_t tick = 0; tick < sample.ticks; ++tick) {
            previous = state;
            ++tickIndex;
            simStep(state, tickIndex);
        }

        summary.totalTicks += sample.ticks;
        summary.totalRequestedTicks += sample.requestedTicks;
        summary.maxTicksInFrame = std::max(summary.maxTicksInFrame, sample.ticks);
        if ((sample.flags & kFrameCapped) != 0u) {
            ++summary.cappedFrames;
        }
        if ((sample.flags & kFramePaused) != 0u) {
            ++summary.pausedFrames;
        }
        if ((sample.flags & kFrameZeroTick) != 0u) {
            ++summary.zeroTickFrames;
        }
        if ((sample.flags & kFrameDtRewind) != 0u) {
            ++summary.rewindFrames;
        }
        if ((sample.flags & kFrameBacklogDrop) != 0u) {
            ++summary.backlogDropFrames;
            summary.backlogDropTicks += sample.droppedTicks;
        }
        // With the ApplicationPC backlog clamp the accumulator is always in
        // [0, one tick]. A dropBacklog=false configuration deliberately keeps
        // the surplus, so only non-negativity is required there.
        if (sample.accUnits < 0) {
            summary.accumulatorInRange = false;
        }
        if (config.dropBacklog && sample.accUnits > config.auPerStep()) {
            summary.accumulatorInRange = false;
        }
    }

    if (frameCount != 0u) {
        summary.durationUs = scenario.timestampsUs.back() - scenario.timestampsUs.front();
        summary.minDeltaUs = summary.samples.front().dtUs;
        summary.maxDeltaUs = summary.samples.front().dtUs;
        for (const FrameSample& sample : summary.samples) {
            summary.minDeltaUs = std::min(summary.minDeltaUs, sample.dtUs);
            summary.maxDeltaUs = std::max(summary.maxDeltaUs, sample.dtUs);
        }
    }

    const FrameSample lastSample = summary.samples.empty() ? FrameSample() : summary.samples.back();
    summary.finalAccUnits = lastSample.accUnits;
    summary.finalAlphaNum = alphaNumerator(lastSample, config);
    summary.finalAlphaDen = alphaDenominator(config);
    summary.finalAlphaBits = doubleBitsHex(static_cast<double>(summary.finalAlphaNum) /
                                           static_cast<double>(summary.finalAlphaDen));

    summary.state = state;
    summary.stateHash = hashSimState(state);

    // Render-side extrapolation of the inspected state between the two most
    // recent ticks. Integer, so the value is comparable exactly.
    summary.interpDen = static_cast<std::uint64_t>(summary.finalAlphaDen);
    summary.interpAlphaNum = static_cast<std::uint64_t>(summary.finalAlphaNum);
    const std::uint64_t posDelta = state.pos - previous.pos;
    summary.interpNum = previous.pos * summary.interpDen + posDelta * summary.interpAlphaNum;
    summary.interpAlphaInRange =
        summary.finalAlphaNum >= 0 && summary.finalAlphaNum <= summary.finalAlphaDen;
    summary.renderHash = fnv1a64Mix(fnv1a64Mix(fnv1a64Seed(), summary.interpNum),
                                    summary.interpAlphaNum);

    return summary;
}

std::vector<ScenarioSummary> runSuite(const std::vector<Scenario>& scenarios,
                                      const FixedStepConfig& baseConfig) {
    std::vector<ScenarioSummary> summaries;
    summaries.reserve(scenarios.size());
    for (const Scenario& scenario : scenarios) {
        summaries.push_back(runScenario(scenario, baseConfig));
    }
    return summaries;
}

std::string suiteJson(const std::vector<ScenarioSummary>& summaries,
                      const FixedStepConfig& baseConfig, const std::string& target,
                      const std::string& compiler, const std::string& flags,
                      bool includeFrames) {
    std::string out;
    out.reserve(65536);
    JsonEmitter json(out);

    bool alphaInRange = true;
    bool accumulatorInRange = true;
    bool capRespected = true;
    for (const ScenarioSummary& summary : summaries) {
        alphaInRange = alphaInRange && summary.interpAlphaInRange;
        accumulatorInRange = accumulatorInRange && summary.accumulatorInRange;
        for (const FrameSample& sample : summary.samples) {
            capRespected =
                capRespected && sample.ticks >= 0 && sample.ticks <= baseConfig.maxTicksPerFrame;
        }
    }

    json.beginObject();
    json.key("schema");
    json.str("blur-scheduler-probe/1");

    json.key("build");
    json.beginObject();
    json.key("target");
    json.str(target);
    json.key("compiler");
    json.str(compiler);
    json.key("flags");
    json.str(flags);
    json.endObject();

    json.key("config");
    json.beginObject();
    json.key("stepHz");
    json.i64(baseConfig.stepHz);
    json.key("usPerSecond");
    json.i64(baseConfig.usPerSecond);
    json.key("auPerUs");
    json.i64(baseConfig.auPerUs());
    json.key("auPerStep");
    json.i64(baseConfig.auPerStep());
    json.key("maxTicksPerFrame");
    json.i64(baseConfig.maxTicksPerFrame);
    json.key("pauseThresholdUs");
    json.i64(baseConfig.pauseThresholdUs);
    json.key("defaultDropBacklog");
    json.boolean(baseConfig.dropBacklog);
    json.key("timeBase");
    json.str("integer microseconds; accumulator in 1/stepHz microsecond units");
    json.key("pauseRule");
    json.str("delta > pauseThresholdUs is a pause: accumulator cleared, delta discarded");
    json.endObject();

    json.key("checks");
    json.beginObject();
    json.key("alphaInRange");
    json.boolean(alphaInRange);
    json.key("accumulatorInRange");
    json.boolean(accumulatorInRange);
    json.key("capRespected");
    json.boolean(capRespected);
    json.endObject();

    json.key("scenarios");
    json.beginArray();
    for (const ScenarioSummary& summary : summaries) {
        json.beginObject();
        json.key("name");
        json.str(summary.name);
        json.key("note");
        json.str(summary.note);
        json.key("dropBacklog");
        json.boolean(summary.dropBacklog);
        json.key("frames");
        json.i64(summary.frames());
        json.key("durationUs");
        json.i64(summary.durationUs);
        json.key("deltaUs");
        json.beginObject();
        json.key("min");
        json.i64(summary.minDeltaUs);
        json.key("max");
        json.i64(summary.maxDeltaUs);
        json.endObject();
        json.key("totalTicks");
        json.i64(summary.totalTicks);
        json.key("totalRequestedTicks");
        json.i64(summary.totalRequestedTicks);
        json.key("maxTicksInFrame");
        json.i64(summary.maxTicksInFrame);
        json.key("cappedFrames");
        json.i64(summary.cappedFrames);
        json.key("pausedFrames");
        json.i64(summary.pausedFrames);
        json.key("zeroTickFrames");
        json.i64(summary.zeroTickFrames);
        json.key("rewindFrames");
        json.i64(summary.rewindFrames);
        json.key("backlogDropFrames");
        json.i64(summary.backlogDropFrames);
        json.key("backlogDropTicks");
        json.i64(summary.backlogDropTicks);
        json.key("finalAccUnits");
        json.i64(summary.finalAccUnits);
        json.key("finalAlphaNum");
        json.i64(summary.finalAlphaNum);
        json.key("finalAlphaDen");
        json.i64(summary.finalAlphaDen);
        json.key("finalAlphaBits");
        json.str(summary.finalAlphaBits);

        json.key("state");
        json.beginObject();
        json.key("pos");
        json.u64(summary.state.pos);
        json.key("vel");
        json.u64(summary.state.vel);
        json.key("hash");
        json.str(hexU64(summary.stateHash));
        json.endObject();

        json.key("render");
        json.beginObject();
        json.key("interpNum");
        json.u64(summary.interpNum);
        json.key("interpDen");
        json.u64(summary.interpDen);
        json.key("alphaNum");
        json.u64(summary.interpAlphaNum);
        json.key("hash");
        json.str(hexU64(summary.renderHash));
        json.endObject();

        if (includeFrames) {
            json.key("frameDeltas");
            json.arrayI64(collectDeltas(summary));
            json.key("frameTicks");
            json.arrayI64(collectTicks(summary));
            json.key("frameAccUnits");
            json.arrayI64(collectAccUnits(summary));
            json.key("frameFlags");
            json.arrayU32AsI64(collectFlags(summary));
        }

        json.endObject();
    }
    json.endArray();
    json.endObject();

    out += '\n';
    return out;
}

std::string defaultSuiteJson(bool includeFrames) {
    const FixedStepConfig config;
    const std::vector<ScenarioSummary> summaries = runSuite(buildScenarios(), config);
    return suiteJson(summaries, config, buildTargetString(), buildCompilerString(),
                     buildFlagsString(), includeFrames);
}

int suiteSelfTest(std::string* report) {
    int failures = 0;
    const FixedStepConfig config;
    const std::vector<Scenario> scenarios = buildScenarios();
    const std::vector<ScenarioSummary> summaries = runSuite(scenarios, config);

    appendCheck(report, failures, !summaries.empty(), "suite produced scenarios");

    for (const ScenarioSummary& summary : summaries) {
        appendCheck(report, failures, summary.interpAlphaInRange,
                    summary.name + ": alpha in [0,1]");
        appendCheck(report, failures, summary.accumulatorInRange,
                    summary.name + ": accumulator non-negative; clamped to one tick when "
                                    "dropBacklog is on");
        appendCheck(report, failures,
                    summary.maxTicksInFrame <= config.maxTicksPerFrame,
                    summary.name + ": per-frame tick cap respected");
        appendCheck(report, failures,
                    summary.totalTicks == summary.totalRequestedTicks ||
                        summary.cappedFrames != 0 || summary.pausedFrames != 0,
                    summary.name + ": executed ticks match requested ticks when not capped");
        if (summary.pausedFrames == 0 && summary.cappedFrames == 0 &&
            summary.rewindFrames == 0) {
            // With no pause and no cap every microsecond must be consumed, so the
            // tick total is the exact floor of the elapsed time in ticks. This is
            // the no-drift invariant and is checked without floating point.
            const std::int64_t expected =
                (summary.durationUs * config.stepHz) / config.usPerSecond;
            appendCheck(report, failures, summary.totalTicks == expected,
                        summary.name + ": no drift, ticks == floor(duration * stepHz)");
        }
    }

    const ScenarioSummary* six = findScenario(summaries, "equal5s-600f");
    const ScenarioSummary* onefifty = findScenario(summaries, "equal5s-150f");
    const ScenarioSummary* hundred = findScenario(summaries, "equal5s-100f");
    if (six != nullptr && onefifty != nullptr && hundred != nullptr) {
        const bool sameTicks = six->totalTicks == onefifty->totalTicks &&
                               six->totalTicks == hundred->totalTicks;
        appendCheck(report, failures, sameTicks,
                    "frame-rate independence: 600/150/100 frames produce the same tick count");
        appendCheck(report, failures, six->totalTicks == 300,
                    "frame-rate independence: 5 s is exactly 300 ticks");
        const bool sameHash = six->stateHash == onefifty->stateHash &&
                              six->stateHash == hundred->stateHash;
        appendCheck(report, failures, sameHash,
                    "frame-rate independence: 600/150/100 frames produce the same state hash");
        const bool sameAlpha = six->finalAlphaBits == onefifty->finalAlphaBits &&
                               six->finalAlphaBits == hundred->finalAlphaBits;
        appendCheck(report, failures, sameAlpha,
                    "frame-rate independence: 600/150/100 frames produce the same alpha");
    } else {
        appendCheck(report, failures, false, "frame-rate independence scenarios present");
    }

    const ScenarioSummary* boundary = findScenario(summaries, "capboundary-15hz-75f");
    if (boundary != nullptr) {
        // The cap is real: executed + clamped tiles must equal requested ticks.
        appendCheck(report, failures,
                    boundary->totalTicks + boundary->backlogDropTicks ==
                        boundary->totalRequestedTicks,
                    "cap boundary: executed ticks + dropped ticks == requested ticks");
        appendCheck(report, failures, boundary->cappedFrames != 0,
                    "cap boundary: the 4-tick cap fires at exactly 4 requested ticks per frame");
        appendCheck(report, failures, boundary->maxTicksInFrame == 4,
                    "cap boundary: never more than 4 ticks run in a frame");
    } else {
        appendCheck(report, failures, false, "cap-boundary scenario present");
    }

    const ScenarioSummary* hitch = findScenario(summaries, "hitch-250ms-400f");
    if (hitch != nullptr) {
        appendCheck(report, failures, hitch->cappedFrames == 1,
                    "hitch: exactly one frame is capped");
        appendCheck(report, failures, hitch->pausedFrames == 0,
                    "hitch: 250000 us is not a pause (threshold comparison is strict)");
        appendCheck(report, failures, hitch->backlogDropFrames == 1,
                    "hitch: the post-cap backlog clamp fires once");
    } else {
        appendCheck(report, failures, false, "hitch scenario present");
    }

    const ScenarioSummary* gap = findScenario(summaries, "tabgap-5s-400f");
    if (gap != nullptr) {
        appendCheck(report, failures, gap->pausedFrames == 1, "tab gap: exactly one pause frame");
        if (gap->samples.size() > 201u) {
            appendCheck(report, failures, gap->samples[200].ticks == 0,
                        "tab gap: the pause frame runs zero ticks");
            appendCheck(report, failures, gap->samples[200].accUnits == 0,
                        "tab gap: the pause frame clears the accumulator");
        }
    } else {
        appendCheck(report, failures, false, "tab gap scenario present");
    }

    const ScenarioSummary* keep = findScenario(summaries, "keepbacklog-200ms-5f");
    if (keep != nullptr) {
        appendCheck(report, failures, keep->totalTicks == 20,
                    "keep-backlog policy runs 4 ticks on each of 5 frames");
        appendCheck(report, failures, keep->finalAlphaNum == keep->finalAlphaDen,
                    "keep-backlog policy saturates alpha at exactly 1");
        appendCheck(report, failures,
                    !keep->samples.empty() &&
                        keep->samples.back().accUnits > config.auPerStep(),
                    "keep-backlog policy keeps the unconsumed accumulator");
    } else {
        appendCheck(report, failures, false, "keep-backlog scenario present");
    }

    // Determinism: a second full run must be bitwise identical.
    const std::vector<ScenarioSummary> again = runSuite(scenarios, config);
    bool deterministic = again.size() == summaries.size();
    if (deterministic) {
        for (std::size_t i = 0; i < summaries.size(); ++i) {
            const ScenarioSummary& a = summaries[i];
            const ScenarioSummary& b = again[i];
            deterministic = deterministic && a.stateHash == b.stateHash &&
                            a.renderHash == b.renderHash &&
                            a.totalTicks == b.totalTicks &&
                            a.finalAccUnits == b.finalAccUnits &&
                            a.samples.size() == b.samples.size();
            if (deterministic) {
                for (std::size_t f = 0; f < a.samples.size(); ++f) {
                    deterministic = deterministic &&
                                    a.samples[f].ticks == b.samples[f].ticks &&
                                    a.samples[f].accUnits == b.samples[f].accUnits &&
                                    a.samples[f].flags == b.samples[f].flags;
                    if (!deterministic) {
                        break;
                    }
                }
            }
        }
    }
    appendCheck(report, failures, deterministic, "repeated runs are bitwise identical");

    return failures;
}

std::string scenarioCsv(const ScenarioSummary& summary, const FixedStepConfig& baseConfig) {
    std::string out;
    out.reserve(64u * (summary.samples.size() + 1u));
    char line[256];
    std::snprintf(line, sizeof(line), "frame,dtUs,requestedTicks,ticks,accUnits,alpha,flags\n");
    out += line;
    std::int64_t index = 0;
    for (const FrameSample& sample : summary.samples) {
        const double alpha = static_cast<double>(alphaNumerator(sample, baseConfig)) /
                             static_cast<double>(alphaDenominator(baseConfig));
        std::snprintf(line, sizeof(line), "%lld,%lld,%lld,%lld,%lld,%.9f,%u\n",
                      static_cast<long long>(index), static_cast<long long>(sample.dtUs),
                      static_cast<long long>(sample.requestedTicks),
                      static_cast<long long>(sample.ticks),
                      static_cast<long long>(sample.accUnits), alpha, sample.flags);
        out += line;
        ++index;
    }
    return out;
}

} // namespace schedprobe
