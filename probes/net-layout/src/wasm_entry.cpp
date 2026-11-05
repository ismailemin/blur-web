// T-006b layout probe — wasm32 entry points.
//
//   const char* wire_layout_json(void);      // static, stable until next call
//   int         wire_layout_selftest(void);  // 0 = pass

#include "probe_core.h"

#include <string>

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#define WIRE_EXPORT EMSCRIPTEN_KEEPALIVE
#else
#define WIRE_EXPORT
#endif

extern "C"
{
	WIRE_EXPORT const char* wire_layout_json(void)
	{
		// A function-local static keeps the buffer alive for the caller; the
		// node driver copies it out immediately.
		static std::string json = wireprobe::layoutJson();
		return json.c_str();
	}

	WIRE_EXPORT int wire_layout_selftest(void)
	{
		std::string err;
		return wireprobe::selfTest(err) ? 0 : 1;
	}
}
