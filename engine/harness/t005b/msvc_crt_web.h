/* msvc_crt_web.h - the MSVC secure-CRT spellings the engine uses, for the
 * wasm32 harness build only.
 *
 * NOT engine code: this is a build prelude, force-included before every TU of
 * the file-layer harness, exactly like engine/harness/t005c/crt_compat.h is for
 * the scheduler probe. It exists because the engine is written against MSVC's
 * CRT and emscripten provides C99/POSIX names.
 *
 *   _vsnprintf_s(char* buf, size_t size, size_t count, const char* fmt, va_list)
 *
 * The only call site is BizAssert.cpp:66, which passes _TRUNCATE as `count` and
 * ignores the return value: it formats a message into a 2048-byte buffer. Both
 * implementations write at most size-1 characters and NUL-terminate; MSVC
 * returns -1 when it truncates, vsnprintf returns the would-be length. The
 * difference is unobservable at that call site, and truncation still cannot
 * overflow. Everything else about the call is a straight name mapping.
 */
#ifndef BLUR_FILE_SPIKE_MSVC_CRT_WEB_H
#define BLUR_FILE_SPIKE_MSVC_CRT_WEB_H

#include <stdarg.h>
#include <stdio.h>

#if !defined(_vsnprintf_s)
#define _vsnprintf_s(buffer, sizeOfBuffer, count, format, args) \
	vsnprintf((buffer), (sizeOfBuffer), (format), (args))
#endif

#endif /* BLUR_FILE_SPIKE_MSVC_CRT_WEB_H */
