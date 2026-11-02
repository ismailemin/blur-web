// Shared driver: bytes in, deterministic JSON out. Used by the native CLI and
// by the wasm32 export so both go through exactly the same code path.
#pragma once

#include <cstddef>
#include <cstdint>
#include <string>

namespace oracle
{
	struct RunOptions
	{
		std::string inputLabel = "Level.levelphysics";
		std::string target = "unknown";
		std::string flags = "";
		bool selftest = false;
	};

	std::string run(const std::uint8_t* data, std::size_t size, const RunOptions& options);

	// Independent structural self-check (used by CTest and the wasm export).
	// Returns an empty string on success, otherwise the first failure.
	std::string selftest();
}
