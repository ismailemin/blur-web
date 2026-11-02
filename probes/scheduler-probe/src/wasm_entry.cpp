// wasm32 entry points. Built with em++ and driven by tests/verify_scheduler_wasm.mjs.
//
// The JSON buffer is a function-local static std::string: it lives for the
// module lifetime and is never modified after the first call.
#include <string>

#include "scenarios.h"

extern "C" {

const char* sched_probe_json(void) {
    static std::string cached;
    if (cached.empty()) {
        cached = schedprobe::defaultSuiteJson(true);
    }
    return cached.c_str();
}

int sched_probe_selftest(void) {
    return schedprobe::suiteSelfTest(nullptr);
}

} // extern "C"
