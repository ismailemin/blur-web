// Static-mesh query paths, re-expressed from Gravity with the same traversal
// order, the same early-outs and the same integer fields.
#pragma once

#include <cstdint>
#include <vector>

#include "level_physics.h"

namespace oracle
{
	struct CollisionFilter
	{
		// C_CollisionFilter() defaults (narrowphase/CollisionFilter.h:43-50)
		std::uint32_t collisionFlags = 0xFFFFFFFFu;
		std::uint32_t collisionMask = 0xFFFFFFFFu;
		std::uint32_t groupId = 0;
		std::uint32_t groupFlags = 0;
		std::uint32_t groupMask = 0;
		std::uint32_t bodyFlags = 0xFFFFFFFFu;
		std::uint32_t bodyMask = 0xFFFFFFFFu;
		bool negate = false;

		bool can_collide(std::uint32_t triangleFlags) const
		{
			// CollisionFilter.inl:39-43
			return negate != ((collisionMask & triangleFlags) != 0);
		}

		bool can_collide(const CollisionFilter& other) const
		{
			// CollisionFilter.inl:8-37
			const bool poly1 = (collisionFlags & other.collisionMask) != 0;
			const bool poly2 = (collisionMask & other.collisionFlags) != 0;
			const bool body1 = (bodyFlags & other.bodyMask) != 0;
			const bool body2 = (bodyMask & other.bodyFlags) != 0;
			const bool group1 = (groupMask & other.groupFlags) != 0;
			const bool group2 = (groupFlags & other.groupMask) != 0;
			const bool poly = poly1 && poly2;
			const bool not_same_group = (groupId != other.groupId) || (groupId == 0);
			const bool inter_group = (!not_same_group) && group1 && group2;
			const bool body = body1 && body2;
			const bool neg = negate || other.negate;
			return neg != ((poly && body) && (not_same_group || inter_group));
		}
	};

	struct RayQuery
	{
		Vec3 start;
		Vec3 direction;   // unit length, as C_Normal
		float maxDistance = 0.0f;
		float radius = 0.0f; // must be 0: the probe implements the thin branch only
		float maxCosAngle = 0.0f;
		bool doubleSided = false;
		CollisionFilter filter;
	};

	struct RayResult
	{
		bool hit = false;
		bool filterSkippedHeader = false;
		std::uint32_t meshIndex = 0xFFFFFFFFu;
		std::uint32_t leafIndex = 0xFFFFFFFFu;
		std::uint32_t headerIndex = 0xFFFFFFFFu;
		std::uint32_t triangleOrdinal = 0xFFFFFFFFu;
		std::uint32_t engineTriangleIndex = 0xFFFFFFFFu;
		std::uint32_t leafStartOrdinal = 0xFFFFFFFFu;
		std::uint32_t collisionFlags = 0;
		std::uint32_t physicsMaterial = 0;
		std::uint32_t effectMaterial = 0;
		std::uint32_t effectMaterialRaw = 0;
		std::uint32_t userData = 0;
		std::uint32_t normalPacked = 0;
		Vec3 contact;
		Vec3 normal;       // probe-reported normal (ray: stored; cache: normalised)
		Vec3 normalStored; // engine value copied from the triangle (non-unit HenDN3)
		float distance = 0.0f;
		// Trace (thin branch) never assigns C_RayTracingResult::m_CollisionFlags.
		bool collisionFlagsAssignedByEngine = true;
		std::uint32_t engineCollisionFlags = 0; // contract sentinel when unassigned
		// Ray end before the query (start + direction * (maxDistance + radius)).
		Vec3 segmentEnd;
	};

	// Thin ray through one mesh body (OptimisedAABBTree::RayTracing,
	// OptimisedAABBTree.inl:146-228, plus CollideRayTriangleMesh,
	// RayTriangle.inl:44-114).
	void ray_trace_mesh(const Mesh& mesh, const RayQuery& ray, RayResult& out);

	// Probe-level scene rule: iterate m_MeshCollisionBodies in stream order and
	// stop at the first body that reports a hit. bodiesTested is reported.
	RayResult ray_trace_scene(const Level& level, const RayQuery& ray, std::uint32_t& bodiesTested);

	struct CacheTriangle
	{
		Vec3 a, b, c;
		Vec3 normal;
		std::uint32_t normalPacked = 0;
		// Exact value passed to C_LineCollisionCache::AddTriangle:
		// leaf stream byte start + the header group's first leaf-local ordinal.
		std::uint32_t engineTriangleStreamValue = 0;
		std::uint32_t leafStartOrdinal = 0;
		std::uint32_t triangleOrdinal = 0;
		std::uint32_t leafIndex = 0;
		std::uint32_t collisionFlags = 0;
		std::uint32_t physicsMaterial = 0;
		std::uint32_t effectMaterial = 0;    // stored U16 (engine field width)
		std::uint32_t effectMaterialRaw = 0; // source header U32
		std::uint32_t userData = 0;
	};

	struct LineCache
	{
		static const std::uint32_t kSize = 4; // DEFAULT_CACHE_SIZE (LineCollisionCache.h:9)
		CacheTriangle entries[kSize];
		std::uint32_t high = 0;

		bool full() const { return high == kSize; }
		void reset() { high = 0; }
	};

	struct CacheFillStats
	{
		std::uint32_t bodiesConsidered = 0;
		std::uint32_t bodiesAccepted = 0;
		std::uint32_t headersFiltered = 0;
		std::uint32_t trianglesTested = 0;
		std::uint32_t trianglesRejectedByNormal = 0;
	};

	void fill_line_cache(const Level& level, const CRAxisBox& box, const CollisionFilter& filter,
	                     const Vec3& negativeNormal, float maxCosAngle, LineCache& cache,
	                     CacheFillStats& stats);

	// C_LineCollisionCache::Trace thin branch (LineCollisionCache_Trace.inl:184-226).
	bool cache_trace(const LineCache& cache, const RayQuery& ray, RayResult& out);

	struct SphereContact
	{
		Vec3 point;
		Vec3 surfaceNormal;  // probe-derived per-contact normal (exact 1/sqrt)
		Vec3 patchNormal;    // engine C_ContactPatch::m_Normal (zero-guarded)
		float penetration = 0.0f;
		std::uint32_t triangleOrdinal = 0;
		std::uint32_t engineHashValue = 0;
		std::uint32_t bodyPhysicsMaterial = 0;
		std::uint32_t trianglePhysicsMaterial = 0;
		std::uint32_t enginePhysicsMaterial = 0;
		std::uint32_t bodyEffectMaterial = 0;
		std::uint32_t triangleEffectMaterial = 0;
		std::uint32_t engineEffectMaterial = 0;
		std::uint32_t patchIndex = 0;
	};

	struct SphereResult
	{
		static const std::uint32_t kMaxPatches = 6;   // ResultSize.h:4
		static const std::uint32_t kMaxContacts = 16; // ResultSize.h:5
		bool hit = false;
		std::uint32_t patchCount = 0;
		std::uint32_t headersFiltered = 0;
		std::vector<SphereContact> contacts;
	};

	// Sphere vs one mesh body (CollideSphereTriangleMesh<6,16>,
	// SphereTriangle.inl:94-202, driven by OptimisedAABBTree::Collide,
	// OptimisedAABBTree.inl:15-137).
	void sphere_query_mesh(const Mesh& mesh, const Vec3& centre, float radius,
	                       const CollisionFilter& filter, SphereResult& out);

	struct GlobalTriangle
	{
		std::uint32_t meshIndex = 0;
		std::uint32_t leafIndex = 0;
		std::uint32_t ordinalInLeaf = 0;
		std::uint32_t recordIndex = 0;
		Vec3 a, b, c;
		Vec3 normal;
		std::uint32_t normalPacked = 0;
	};

	std::uint32_t total_triangle_count(const Level& level);
	bool global_triangle(const Level& level, std::uint32_t ordinal, GlobalTriangle& out);
}
