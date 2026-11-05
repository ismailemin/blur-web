// T-006b layout probe — measurement core shared by the native and wasm entries.

#ifndef PROBE_CORE_H
#define PROBE_CORE_H

#include <string>

namespace wireprobe
{
	// Full JSON document: build identity + measured layout of every type and
	// derived record. Deterministic: two calls produce the same string.
	std::string layoutJson(void);

	// Internal consistency checks (bounds, duplicate offsets, determinism,
	// endianness). `err` receives the first failure. Returns false on failure.
	bool selfTest(std::string& err);
}

#endif // PROBE_CORE_H
