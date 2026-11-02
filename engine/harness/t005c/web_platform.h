/* web_platform.h - minimal PLATFORM_WEB prelude for the engine port spike.
 *
 * NOT engine code, NOT a project header. Force-included (-include) by
 * build_probe.py. Every definition here is either a standard typedef, a
 * compiler intrinsic alias, or a body copied verbatim from the engine source
 * (the citation is in the comment). Nothing here invents numeric semantics.
 *
 * Rule followed: if the only fix is a guard change inside an upstream header,
 * the definition is NOT added here. Those cases are reported as source edits
 * in docs/work/analysis/engine-web-shims.md, because hiding them in a prelude
 * would make the required upstream diff invisible.
 */
#ifndef BLUR_SPIKE_WEB_PLATFORM_H
#define BLUR_SPIKE_WEB_PLATFORM_H

#if !defined(__EMSCRIPTEN__)
#error "web_platform.h is only valid for an emscripten (wasm32) spike build"
#endif

/* 1. Platform identity -------------------------------------------------------
 * The engine has no PLATFORM_WEB. Defining it here only makes it visible to
 * #ifdef; core/Core.h still falls through to PLATFORM_LINUX because neither
 * _WIN32 nor WIN32 is set. That double identity is exactly what the spike
 * measures.
 */
#ifndef PLATFORM_WEB
#define PLATFORM_WEB 1
#endif

/* 2. PowerPC select intrinsic ------------------------------------------------
 * core/maths/MathsUtil.h:1499-1500 call __fsel() with no platform guard, and
 * the only software definition the engine ships (MathsUtil.h:412-414) is
 * compiled for PLATFORM_PC/PLATFORM_SPU only.
 *
 * The body below is the engine's own software definition, character for
 * character (MathsUtil.h:413):
 *     INLINE F32 __fsel(F32 cmp, F32 a, F32 b) { return (cmp>=0)?a:b; }
 * so this introduces no new numeric behaviour. It is a function-like macro
 * instead of an inline function only because the prelude is compiled before
 * the engine's own types (F32/INLINE) exist.
 */
#if !defined(PLATFORM_PC) && !defined(PLATFORM_SPU) && !defined(__fsel)
#define __fsel(cmp, a, b) (((cmp) >= 0.0f) ? (a) : (b))
#endif

#include "crt_compat.h"

#endif /* BLUR_SPIKE_WEB_PLATFORM_H */