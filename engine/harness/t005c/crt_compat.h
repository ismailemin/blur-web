/* crt_compat.h - MSVC CRT spellings that the engine uses, mapped to the C99
 * names emscripten/musl provides. Included by web_platform.h.
 *
 * Each entry is a name mapping, not a behaviour: the C99 function has the same
 * contract as the MSVC underscore variant. No numeric value is invented here;
 * _TRUNCATE is the engine's own definition, copied from core/Core.h:724
 * (PLATFORM_PC) and core/Core.h:500 (PLATFORM_PS3/SPU).
 *
 * Only added when a real TU needed it; see docs/work/analysis/engine-web-shims.md
 * for the TU and error count that motivated each line.
 */
#ifndef BLUR_SPIKE_CRT_COMPAT_H
#define BLUR_SPIKE_CRT_COMPAT_H

#include <stddef.h>
#include <math.h>
#include <stdio.h>

/* core/Core.h:724 defines this for PLATFORM_PC only (`#define _TRUNCATE
 * ((size_t)-1)`); used by core/utility/BizAssert.cpp:66 (strncpy_s). */
#ifndef _TRUNCATE
#define _TRUNCATE ((size_t)-1)
#endif

/* MSVC: int _isnan(double). C99: int isnan(double) - same predicate.
 * 29 sites in core/maths/hvec/new/Mat44.cpp, 137 in physics/gravity. */
#ifndef _isnan
#define _isnan(x) isnan(x)
#endif

/* MSVC: int _finite(double). core/Core.h:355 already aliases this to isfinite
 * for the GNU compiler branch (`#define _finite isfinite`), so the shim must
 * NOT define it: the engine's definition already covers COMPILER_GNU. */

#endif /* BLUR_SPIKE_CRT_COMPAT_H */
