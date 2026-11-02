// wasm32 exports. The host copies the file into the module heap and calls
// oracle_run(ptr,size); the returned UTF-8 JSON is released with oracle_free.
// A truncated or malformed buffer is reported inside the JSON, never trapped.
#include <cstdlib>
#include <cstring>
#include <string>

#include "oracle_run.h"

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#define ORACLE_EXPORT EMSCRIPTEN_KEEPALIVE
#define ORACLE_FLAGS_STRING "emcc -O2 -ffp-contract=off -fno-fast-math"
#else
#define ORACLE_EXPORT
#define ORACLE_FLAGS_STRING "unknown"
#endif

extern "C"
{
	ORACLE_EXPORT char* oracle_run(const char* data, int size)
	{
		oracle::RunOptions options;
		options.inputLabel = "wasm-buffer";
		options.target = "wasm32-emscripten";
		options.flags = ORACLE_FLAGS_STRING;

		const char* payload = (data != nullptr && size > 0) ? data : nullptr;
		const std::string json = oracle::run(reinterpret_cast<const std::uint8_t*>(payload),
		                                     payload ? static_cast<std::size_t>(size) : 0u,
		                                     options);
		char* out = static_cast<char*>(std::malloc(json.size() + 1));
		if (out == nullptr)
			return nullptr;
		std::memcpy(out, json.data(), json.size());
		out[json.size()] = '\0';
		return out;
	}

	ORACLE_EXPORT void oracle_free(char* p)
	{
		std::free(p);
	}

	ORACLE_EXPORT const char* oracle_selftest()
	{
		static std::string result;
		result = oracle::selftest();
		return result.empty() ? "PASS" : result.c_str();
	}

	ORACLE_EXPORT const char* oracle_flags()
	{
		return ORACLE_FLAGS_STRING;
	}
}
