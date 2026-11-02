// Native entry point for the T-005c fixed-step probe.
//
//   scheduler_probe --out native.json [--csv <dir>] [--no-frames]
//   scheduler_probe --selftest
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

#include "scenarios.h"

namespace {

const char* kUsage =
    "usage: scheduler_probe [--out <json>] [--csv <dir>] [--no-frames] [--quiet]\n"
    "       scheduler_probe --selftest\n";

bool writeTextFile(const std::string& path, const std::string& content) {
    std::ofstream stream(path, std::ios::binary | std::ios::trunc);
    if (!stream) {
        std::fprintf(stderr, "cannot open %s for writing\n", path.c_str());
        return false;
    }
    stream.write(content.data(), static_cast<std::streamsize>(content.size()));
    return stream.good();
}

} // namespace

int main(int argc, char** argv) {
    std::string outPath;
    std::string csvDir;
    bool includeFrames = true;
    bool quiet = false;
    bool runSelfTest = false;

    for (int index = 1; index < argc; ++index) {
        const std::string argument = argv[index];
        if (argument == "--out" && index + 1 < argc) {
            outPath = argv[++index];
        } else if (argument == "--csv" && index + 1 < argc) {
            csvDir = argv[++index];
        } else if (argument == "--no-frames") {
            includeFrames = false;
        } else if (argument == "--quiet") {
            quiet = true;
        } else if (argument == "--selftest") {
            runSelfTest = true;
        } else if (argument == "--help" || argument == "-h") {
            std::fputs(kUsage, stdout);
            return 0;
        } else {
            std::fprintf(stderr, "unknown argument: %s\n", argument.c_str());
            std::fputs(kUsage, stderr);
            return 2;
        }
    }

    if (runSelfTest) {
        std::string report;
        const int failures = schedprobe::suiteSelfTest(&report);
        std::fputs(report.c_str(), stdout);
        std::printf("selftest: %s (%d failures)\n", failures == 0 ? "PASS" : "FAIL", failures);
        return failures == 0 ? 0 : 1;
    }

    const std::string json = schedprobe::defaultSuiteJson(includeFrames);
    if (!outPath.empty()) {
        if (!writeTextFile(outPath, json)) {
            return 3;
        }
        if (!quiet) {
            std::printf("wrote %s (%zu bytes)\n", outPath.c_str(), json.size());
        }
    } else if (!quiet) {
        std::fputs(json.c_str(), stdout);
    }

    if (!csvDir.empty()) {
        std::error_code error;
        std::filesystem::create_directories(csvDir, error);
        if (error) {
            std::fprintf(stderr, "cannot create %s: %s\n", csvDir.c_str(),
                         error.message().c_str());
            return 3;
        }
        const schedprobe::FixedStepConfig config;
        const std::vector<schedprobe::ScenarioSummary> summaries =
            schedprobe::runSuite(schedprobe::buildScenarios(), config);
        for (const schedprobe::ScenarioSummary& summary : summaries) {
            const std::string path = csvDir + "/" + summary.name + ".csv";
            if (!writeTextFile(path, schedprobe::scenarioCsv(summary, config))) {
                return 3;
            }
        }
        if (!quiet) {
            std::printf("wrote %zu CSV files to %s\n", summaries.size(), csvDir.c_str());
        }
    }

    return 0;
}
