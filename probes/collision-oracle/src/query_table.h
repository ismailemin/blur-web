// Fixed, reproducible query fixture. Every coordinate is derived from the
// parsed mesh with exact binary32 operations, so the Python reference can
// regenerate the same table without sharing code.
#pragma once

#include <string>
#include <vector>

#include "queries.h"

namespace oracle
{
	struct RayQueryEntry
	{
		std::string label;
		RayQuery ray;
	};

	struct SphereQueryEntry
	{
		std::string label;
		Vec3 centre;
		float radius = 0.0f;
	};

	struct CacheQueryEntry
	{
		std::string label;
		CRAxisBox box;
		Vec3 negativeNormal;
		float maxCosAngle = 0.0f;
		RayQuery trace;
	};

	struct QueryTable
	{
		std::vector<RayQueryEntry> rays;
		std::vector<SphereQueryEntry> spheres;
		std::vector<CacheQueryEntry> cacheQueries;
	};

	// xorshift32 (Marsaglia 2003). Seed and consumption order are pinned so the
	// table is identical in C++ and Python.
	class Rng
	{
	public:
		explicit Rng(std::uint32_t seed) : m_state(seed ? seed : 1u) {}

		std::uint32_t next()
		{
			m_state ^= m_state << 13;
			m_state ^= m_state >> 17;
			m_state ^= m_state << 5;
			return m_state;
		}

		// (u >> 8) is exactly representable in binary32; 2^-24 is exact.
		float unit() { return static_cast<float>(next() >> 8) * (1.0f / 16777216.0f); }

	private:
		std::uint32_t m_state;
	};

	inline Vec3 lerp_bounds(const Vec3& lo, const Vec3& hi, float ux, float uy, float uz)
	{
		return Vec3(lo.x + (hi.x - lo.x) * ux,
		            lo.y + (hi.y - lo.y) * uy,
		            lo.z + (hi.z - lo.z) * uz);
	}

	QueryTable build_query_table(const Level& level);
}
