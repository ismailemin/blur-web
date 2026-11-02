#include "query_table.h"

namespace oracle
{
	namespace
	{
		constexpr std::uint32_t kRayCount = 24;
		constexpr std::uint32_t kSphereCount = 24;
		constexpr std::uint32_t kCacheCount = 8;
		constexpr std::uint32_t kDownRays = 12;
		constexpr std::uint32_t kSpherePoints = 6;
		constexpr std::uint32_t kSphereNearSurface = 10;

		// Wheel query constants (racingphysics/.../car.cpp:610-618)
		constexpr float kWheelDescentRange = 2.0f;
		constexpr float kWheelMaxCosAngle = -0.25f;

		Vec3 normalized_or_up(const Vec3& d)
		{
			const float len2 = dot(d, d);
			if (!(len2 > 1.0e-6f))
				return Vec3(0.0f, 1.0f, 0.0f);
			const float len = std::sqrt(len2);
			return Vec3(d.x / len, d.y / len, d.z / len);
		}
	}

	QueryTable build_query_table(const Level& level)
	{
		QueryTable table;
		const Vec3 lo = level.boundsMin();
		const Vec3 hi = level.boundsMax();
		const std::uint32_t totalTriangles = total_triangle_count(level);

		// ---- 24 rays -------------------------------------------------------
		for (std::uint32_t i = 0; i < kDownRays; ++i)
		{
			RayQueryEntry e;
			e.label = "ray-down-" + std::to_string(i);
			// 4 x 3 grid over the horizontal bounds, from above the top plane.
			const std::uint32_t gx = i % 4u;
			const std::uint32_t gz = i / 4u;
			const float ux = (static_cast<float>(gx) + 0.5f) * 0.25f;
			const float uz = (static_cast<float>(gz) + 0.5f) / 3.0f;
			e.ray.start = Vec3(lo.x + (hi.x - lo.x) * ux,
			                   hi.y + kWheelDescentRange + 2.0f,
			                   lo.z + (hi.z - lo.z) * uz);
			e.ray.direction = Vec3(0.0f, -1.0f, 0.0f);
			e.ray.maxDistance = (hi.y - lo.y) + 8.0f;
			e.ray.radius = 0.0f;
			e.ray.maxCosAngle = kWheelMaxCosAngle;
			e.ray.doubleSided = false;
			table.rays.push_back(e);
		}
		for (std::uint32_t i = kDownRays; i < kRayCount; ++i)
		{
			RayQueryEntry e;
			e.label = "ray-random-" + std::to_string(i);
			Rng rng(0xA5A50000u + i);
			const std::uint32_t ord = (totalTriangles == 0) ? 0u : (rng.next() % totalTriangles);
			GlobalTriangle tri;
			const bool haveTriangle = global_triangle(level, ord, tri);
			Vec3 centroid = lerp_bounds(lo, hi, 0.5f, 0.5f, 0.5f);
			if (haveTriangle)
			{
				centroid = Vec3((tri.a.x + tri.b.x + tri.c.x) / 3.0f,
				                (tri.a.y + tri.b.y + tri.c.y) / 3.0f,
				                (tri.a.z + tri.b.z + tri.c.z) / 3.0f);
			}
			// Origin on a deterministic sphere around the target, aimed at the
			// centroid, so the traversal and the triangle test are both exercised.
			// Each RNG draw is sequenced into its own statement: relying on
			// function-argument evaluation order made MSVC and clang disagree.
			const float ox = rng.unit() * 2.0f - 1.0f;
			const float oy = rng.unit() * 2.0f - 1.0f;
			const float oz = rng.unit() * 2.0f - 1.0f;
			const Vec3 offset(ox, oy, oz);
			const Vec3 dir = normalized_or_up(offset);
			e.ray.start = centroid + dir * 40.0f;
			e.ray.direction = -dir;
			e.ray.maxDistance = 60.0f;
			e.ray.radius = 0.0f;
			e.ray.maxCosAngle = 1.0f; // accept every facing; diagnostic branch
			e.ray.doubleSided = false;
			table.rays.push_back(e);
		}

		// ---- 24 sphere / point queries -------------------------------------
		for (std::uint32_t i = 0; i < kSpherePoints; ++i)
		{
			SphereQueryEntry e;
			e.label = "point-vertex-" + std::to_string(i);
			const std::uint32_t ord = (totalTriangles == 0) ? 0u : (i * totalTriangles) / kSpherePoints;
			GlobalTriangle tri;
			// A radius-0 sphere centred exactly on a decoded vertex must report a
			// contact with penetration 0; it is the cheapest decoding self-check
			// that also runs the tree traversal.
			if (global_triangle(level, ord, tri))
				e.centre = tri.a;
			else
				e.centre = lerp_bounds(lo, hi, 0.5f, 0.5f, 0.5f);
			e.radius = 0.0f;
			table.spheres.push_back(e);
		}
		for (std::uint32_t i = 0; i < kSphereNearSurface; ++i)
		{
			SphereQueryEntry e;
			e.label = "sphere-near-" + std::to_string(i);
			Rng rng(0xBEEF0000u + i);
			const std::uint32_t ord = (totalTriangles == 0) ? 0u : (rng.next() % totalTriangles);
			const float radius = 0.25f + 2.0f * rng.unit();
			GlobalTriangle tri;
			if (global_triangle(level, ord, tri))
			{
				const Vec3 centroid((tri.a.x + tri.b.x + tri.c.x) / 3.0f,
				                    (tri.a.y + tri.b.y + tri.c.y) / 3.0f,
				                    (tri.a.z + tri.b.z + tri.c.z) / 3.0f);
				const float lift = 0.5f * radius;
				e.centre = centroid + tri.normal * lift;
			}
			else
			{
				e.centre = lerp_bounds(lo, hi, 0.5f, 0.5f, 0.5f);
			}
			e.radius = radius;
			table.spheres.push_back(e);
		}
		for (std::uint32_t i = kSpherePoints + kSphereNearSurface; i < kSphereCount; ++i)
		{
			SphereQueryEntry e;
			e.label = "sphere-empty-" + std::to_string(i);
			Rng rng(0xC0DE0000u + i);
			const float ux = rng.unit();
			const float uy = rng.unit();
			const float uz = rng.unit();
			e.centre = lerp_bounds(lo, hi, ux, uy, uz);
			e.radius = 0.5f + 3.0f * rng.unit();
			table.spheres.push_back(e);
		}

		// ---- 8 line-cache fill + trace queries -----------------------------
		for (std::uint32_t i = 0; i < kCacheCount; ++i)
		{
			CacheQueryEntry e;
			e.label = "cache-" + std::to_string(i);
			GlobalTriangle tri;
			const std::uint32_t ord = (totalTriangles == 0) ? 0u : (i * totalTriangles) / kCacheCount;
			if (i + 1 == kCacheCount)
			{
				// Whole-level box: exercises the four-entry cache cap and the
				// early return of FillLineCollisionCache.
				e.box.centre = Vec3((lo.x + hi.x) * 0.5f, (lo.y + hi.y) * 0.5f, (lo.z + hi.z) * 0.5f);
				e.box.extents = Vec3((hi.x - lo.x) * 0.5f + 10.0f,
				                     (hi.y - lo.y) * 0.5f + 10.0f,
				                     (hi.z - lo.z) * 0.5f + 10.0f);
			}
			else if (global_triangle(level, ord, tri))
			{
				const Vec3 centroid((tri.a.x + tri.b.x + tri.c.x) / 3.0f,
				                    (tri.a.y + tri.b.y + tri.c.y) / 3.0f,
				                    (tri.a.z + tri.b.z + tri.c.z) / 3.0f);
				e.box.centre = centroid + tri.normal * 1.0f;
				e.box.extents = Vec3(1.5f, 1.5f, 1.5f);
			}
			else
			{
				e.box.centre = lerp_bounds(lo, hi, 0.5f, 0.5f, 0.5f);
				e.box.extents = Vec3(1.5f, 1.5f, 1.5f);
			}
			e.negativeNormal = Vec3(0.0f, -1.0f, 0.0f);
			e.maxCosAngle = kWheelMaxCosAngle;

			e.trace.start = Vec3(e.box.centre.x,
			                     e.box.centre.y + e.box.extents.y + 2.0f,
			                     e.box.centre.z);
			e.trace.direction = Vec3(0.0f, -1.0f, 0.0f);
			e.trace.maxDistance = 20.0f;
			e.trace.radius = 0.0f;
			e.trace.maxCosAngle = kWheelMaxCosAngle;
			e.trace.doubleSided = false;
			table.cacheQueries.push_back(e);
		}

		return table;
	}
}
