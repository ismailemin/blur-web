// Build identity recorded next to every hash. The numeric flags are injected by
// the build so a future hash divergence can be traced to the exact flags.
#pragma once

#include <string>

#if defined(__EMSCRIPTEN__)
#include <emscripten/version.h>
#endif

namespace schedprobe {

#if defined(__EMSCRIPTEN__)
#define SCHEDPROBE_TARGET "wasm32"
#elif defined(_MSC_VER)
#define SCHEDPROBE_TARGET "native-msvc"
#elif defined(__GNUC__)
#define SCHEDPROBE_TARGET "native-gnu"
#else
#define SCHEDPROBE_TARGET "unknown"
#endif

inline std::string buildTargetString() {
    return SCHEDPROBE_TARGET;
}

inline std::string buildCompilerString() {
#if defined(__EMSCRIPTEN__)
    return "emscripten " + std::to_string(__EMSCRIPTEN_major__) + "." +
           std::to_string(__EMSCRIPTEN_minor__) + "." + std::to_string(__EMSCRIPTEN_tiny__);
#elif defined(_MSC_VER)
    return "msvc " + std::to_string(_MSC_VER);
#elif defined(__clang__)
    return "clang " + std::to_string(__clang_major__) + "." + std::to_string(__clang_minor__);
#elif defined(__GNUC__)
    return "gcc " + std::to_string(__GNUC__) + "." + std::to_string(__GNUC_MINOR__);
#else
    return "unknown";
#endif
}

inline std::string buildFlagsString() {
#ifdef PROBE_FLAGS_STRING
    return PROBE_FLAGS_STRING;
#else
    return "unspecified";
#endif
}

} // namespace schedprobe
