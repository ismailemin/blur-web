#include "queries.h"

namespace oracle
{
	namespace
	{
		constexpr std::uint32_t kStackSlots = 512;
		// sizeof(C_TriangleHeader) / sizeof(AABBTreeTriangle) on x86/x64.
		constexpr std::uint32_t kHeaderBytes = 16;
		constexpr std::uint32_t kTriangleBytes = 12;

		Vec3 decode_cached_vertex(const Mesh& mesh, const NodeRecord& node, std::uint8_t index)
		{
			const std::size_t base = (static_cast<std::size_t>(node.vertexStart) + index) * 3;
			const Vec3 local(decode_fixed_s16_14(mesh.vertexS16[base + 0]),
			                 decode_fixed_s16_14(mesh.vertexS16[base + 1]),
			                 decode_fixed_s16_14(mesh.vertexS16[base + 2]));
			const Vec3 range = node.box.max - node.box.min;
			return local * range + node.box.min;
		}

		struct HeaderSpan
		{
			std::uint32_t first = 0;
			std::uint32_t count = 0;
		};

		HeaderSpan headers_of(const NodeRecord& node)
		{
			HeaderSpan span;
			span.first = node.firstHeader;
			span.count = node.numHeaders;
			return span;
		}
	}

	// ---------------------------------------------------------------- ray trace

	namespace
	{
		struct LeafRayHit
		{
			bool hit = false;
			Vec3 contact;
			Vec3 normal;
			float distance = 0.0f;
			std::uint32_t engineTriangleIndex = 0;
			std::uint32_t headerIndex = 0;
			std::uint32_t triangleInGroup = 0;
			std::uint32_t triangleRecord = 0;
			Vec3 segmentEnd;
		};

		void trace_leaf(const Mesh& mesh, const NodeRecord& node, const RayQuery& ray,
		                const Vec3& segmentEnd, LeafRayHit& out)
		{
			// CollideRayTriangleMesh (RayTriangle.inl:44-114)
			Vec3 temp = segmentEnd;
			Vec3 normal; // C_Normal default: zero length
			std::uint32_t triangleIndex = 0;
			bool collide = false;
			std::uint32_t acceptedHeader = 0;
			std::uint32_t acceptedTriangle = 0;
			std::uint32_t acceptedGroupOffset = 0;

			std::uint32_t a = 0;
			std::uint32_t offset = 0;
			std::uint32_t headerSlot = 0;
			const std::uint32_t headerFirst = headers_of(node).first;

			while (a < node.triangleSizeIndices)
			{
				if (headerSlot >= mesh.headers.size())
					break;
				const HeaderRecord& header = mesh.headers[headerFirst + headerSlot];
				const std::uint32_t numTris = header.numTriangles;
				offset += kHeaderBytes;
				const std::uint32_t groupTriangleOffset = offset;

				if (ray.filter.can_collide(header.collisionFlags))
				{
					const std::uint32_t count =
						(a + numTris > node.triangleSizeIndices) ? (node.triangleSizeIndices - a) : numTris;
					for (std::uint32_t i = 0; i < count; ++i)
					{
						const std::uint32_t recordIndex = header.firstTriangle + i;
						const TriangleRecord& tri = mesh.triangles[recordIndex];
						const Vec3 a0 = decode_cached_vertex(mesh, node, tri.indexA);
						const Vec3 b0 = decode_cached_vertex(mesh, node, tri.indexB);
						const Vec3 c0 = decode_cached_vertex(mesh, node, tri.indexC);

						const Vec3 norm = decode_hen_dn3(tri.normalPacked);
						const float cosAngle = dot(norm, ray.direction);
						const bool doubleSided = ray.doubleSided && (cosAngle > 0.0f);
						const Vec3 normSelect = doubleSided ? -norm : norm;
						const float cosSelect = doubleSided ? -cosAngle : cosAngle;
						const Vec3 b = doubleSided ? c0 : b0;
						const Vec3 c = doubleSided ? b0 : c0;

						Vec3 hitPoint;
						const bool inside =
							(cosSelect < ray.maxCosAngle) &&
							intersect_triangle_segment(a0, b, c, ray.start, temp, hitPoint);
						if (inside)
						{
							temp = hitPoint;
							normal = normSelect;
							triangleIndex = i;
							acceptedHeader = headerFirst + headerSlot;
							acceptedTriangle = recordIndex;
							acceptedGroupOffset = groupTriangleOffset;
							collide = true;
						}
					}
				}

				offset = groupTriangleOffset + numTris * kTriangleBytes;
				a += numTris;
				++headerSlot;
			}

			if (collide)
			{
				out.hit = true;
				out.contact = temp;
				out.normal = normal;
				out.distance = dot(temp - ray.start, ray.direction);
				out.engineTriangleIndex = acceptedGroupOffset + kTriangleBytes * triangleIndex;
				out.headerIndex = acceptedHeader;
				out.triangleInGroup = triangleIndex;
				out.triangleRecord = acceptedTriangle;
				out.segmentEnd = temp;
			}
		}
	}

	void ray_trace_mesh(const Mesh& mesh, const RayQuery& ray, RayResult& out)
	{
		out = RayResult();
		out.segmentEnd = ray.start + ray.direction * (ray.maxDistance + ray.radius);

		const Vec3 radius(ray.radius, ray.radius, ray.radius);
		Vec3 contact = out.segmentEnd;
		Vec3 normal;
		float distance = ray.maxDistance;
		bool hit = false;
		std::uint32_t hitLeaf = 0xFFFFFFFFu;
		std::uint32_t hitHeader = 0xFFFFFFFFu;
		std::uint32_t hitEngineIndex = 0xFFFFFFFFu;
		std::uint32_t hitOrdinal = 0xFFFFFFFFu;
		std::uint32_t hitNormalPacked = 0;
		Vec3 hitContact;
		Vec3 hitNormal;

		std::uint32_t stack[kStackSlots];
		std::uint32_t size = 1;
		stack[0] = 0;
		std::uint32_t topNode = 0; // pStackTop, overwritten by the pop

		while (size != 0)
		{
			--size;
			const std::uint32_t nodeIndex = topNode;
			const std::uint32_t popIndex = (size > 0) ? (size - 1) : 0;
			topNode = stack[popIndex];

			if (nodeIndex >= mesh.numNodes)
				break;
			const NodeRecord& node = mesh.nodes[nodeIndex];

			const Vec3 bmin = node.box.min - radius;
			const Vec3 bmax = node.box.max + radius;
			if (!intersect_ray_aabb(ray.start, contact, bmin, bmax))
				continue;

			if (node.triangleSizeIndices == 0)
			{
				if (size + 2 > kStackSlots)
					break;
				stack[size] = nodeIndex + node.startOrRightOffset;
				size += 2; // engine: Push(right,size); size += 2; descend left immediately
				topNode = nodeIndex + 1;
				continue;
			}

			LeafRayHit leafHit;
			trace_leaf(mesh, node, ray, contact, leafHit);
			if (leafHit.hit)
			{
				hit = true;
				contact = leafHit.contact;
				normal = leafHit.normal;
				distance = leafHit.distance;
				hitLeaf = nodeIndex;
				hitHeader = leafHit.headerIndex;
				hitEngineIndex = leafHit.engineTriangleIndex;
				hitContact = leafHit.contact;
				hitNormal = leafHit.normal;

				const HeaderRecord& h = mesh.headers[leafHit.headerIndex];
				out.collisionFlags = h.collisionFlags;
				out.physicsMaterial = h.physicsMaterial;
				out.effectMaterial = h.effectMaterial;
				out.userData = h.userDataFlags;

				const TriangleRecord& t = mesh.triangles[leafHit.triangleRecord];
				hitOrdinal = t.ordinalInLeaf;
				hitNormalPacked = t.normalPacked;
			}
		}

		if (!hit)
		{
			out.segmentEnd = ray.start + ray.direction * (ray.maxDistance + ray.radius);
			return;
		}

		out.hit = true;
		out.meshIndex = mesh.index;
		out.leafIndex = hitLeaf;
		out.headerIndex = hitHeader;
		out.triangleOrdinal = hitOrdinal;
		out.engineTriangleIndex = hitEngineIndex;
		out.normalPacked = hitNormalPacked;
		out.contact = hitContact;
		out.normal = hitNormal;
		out.distance = distance;
		out.segmentEnd = contact;
	}

	RayResult ray_trace_scene(const Level& level, const RayQuery& ray, std::uint32_t& bodiesTested)
	{
		bodiesTested = 0;
		for (const Mesh& mesh : level.meshes)
		{
			++bodiesTested;
			RayResult r;
			ray_trace_mesh(mesh, ray, r);
			if (r.hit)
				return r;
		}
		return RayResult();
	}

	// --------------------------------------------------------------- cache fill

	void fill_line_cache(const Level& level, const CRAxisBox& box, const CollisionFilter& filter,
	                     const Vec3& negativeNormal, float maxCosAngle, LineCache& cache,
	                     CacheFillStats& stats)
	{
		cache.reset();
		stats = CacheFillStats();

		const CollisionFilter meshFilter; // shape filter merged with m_CollisionFlag
		for (const Mesh& mesh : level.meshes)
		{
			++stats.bodiesConsidered;
			if (!meshFilter.can_collide(filter))
				continue;
			++stats.bodiesAccepted;

			for (const LeafRecord& leaf : mesh.leaves)
			{
				if (cache.full())
					return;
				if (!box_intersects_minmax(leaf.box, box))
					continue;

				const NodeRecord& node = mesh.nodes[leaf.nodeIndex];
				const Vec3 range = leaf.box.max - leaf.box.min;

				std::uint32_t a = 0;
				std::uint32_t offset = 0;
				std::uint32_t headerSlot = 0;
				const std::uint32_t headerFirst = headers_of(node).first;

				while (a < leaf.triangleSizeIndices)
				{
					if (headerSlot >= mesh.headers.size())
						break;
					const HeaderRecord& header = mesh.headers[headerFirst + headerSlot];
					const std::uint32_t numTris = header.numTriangles;
					offset += kHeaderBytes;
					const std::uint32_t groupOffset = offset;

					if (!filter.can_collide(header.collisionFlags))
					{
						++stats.headersFiltered;
						offset = groupOffset + numTris * kTriangleBytes;
						a += numTris;
						++headerSlot;
						continue;
					}

					const std::uint32_t count = (a + numTris > leaf.triangleSizeIndices)
						? (leaf.triangleSizeIndices - a) : numTris;
					for (std::uint32_t i = 0; i < count; ++i)
					{
						const TriangleRecord& tri = mesh.triangles[header.firstTriangle + i];
						const Vec3 v0 = decode_cached_vertex(mesh, node, tri.indexA);
						const Vec3 v1 = decode_cached_vertex(mesh, node, tri.indexB);
						const Vec3 v2 = decode_cached_vertex(mesh, node, tri.indexC);

						AxisBoxMinMax triBox;
						triBox.max = vmax(v0, vmax(v1, v2));
						triBox.min = vmin(v0, vmin(v1, v2));

						++stats.trianglesTested;
						if (!box_intersects_minmax(triBox, box) || !intersect_aabb_triangle(box, v0, v1, v2))
							continue;

						const Vec3 normal = decode_hen_dn3(tri.normalPacked);
						if (dot(normal, negativeNormal) > maxCosAngle)
						{
							++stats.trianglesRejectedByNormal;
							continue;
						}
						if (cache.full())
							return;

						CacheTriangle& entry = cache.entries[cache.high++];
						entry.a = v0;
						entry.b = v1;
						entry.c = v2;
						entry.normal = normal;
						entry.normalPacked = tri.normalPacked;
						entry.engineTriangleIndex = leaf.triangleBufferStart + tri.ordinalInLeaf;
						entry.triangleOrdinal = tri.ordinalInLeaf;
						entry.leafIndex = leaf.nodeIndex;
						entry.collisionFlags = header.collisionFlags;
						entry.physicsMaterial = header.physicsMaterial;
						entry.effectMaterial = header.effectMaterial & 0xFFFFu; // U16 truncation
						entry.effectMaterialRaw = header.effectMaterial;
						entry.userData = header.userDataFlags;
					}

					offset = groupOffset + numTris * kTriangleBytes;
					a += numTris;
					++headerSlot;
				}
			}
		}
	}

	bool cache_trace(const LineCache& cache, const RayQuery& ray, RayResult& out)
	{
		out = RayResult();
		out.segmentEnd = ray.start + ray.direction * (ray.maxDistance + ray.radius);

		Vec3 contact = out.segmentEnd;
		std::int32_t hitIndex = -1;

		for (std::uint32_t a = 0; a < cache.high; ++a)
		{
			const CacheTriangle& tri = cache.entries[a];
			if (!ray.filter.can_collide(tri.collisionFlags))
				continue;

			const float planeD = dot(tri.normal, tri.a) + ray.radius;
			const float disStart = dot(ray.start, tri.normal) - planeD;
			const float disEnd = dot(out.segmentEnd, tri.normal) - planeD;
			if (disStart * disEnd > 0.0f)
				continue;

			Vec3 hitPoint;
			const bool bb = intersect_triangle_segment(tri.a, tri.b, tri.c, ray.start, contact, hitPoint);
			if (bb)
			{
				contact = hitPoint;
				hitIndex = static_cast<std::int32_t>(a);
			}
		}

		if (hitIndex < 0)
			return false;

		const CacheTriangle& tri = cache.entries[hitIndex];
		out.hit = true;
		out.leafIndex = tri.leafIndex;
		out.engineTriangleIndex = tri.engineTriangleIndex;
		out.triangleOrdinal = tri.triangleOrdinal;
		out.collisionFlags = tri.collisionFlags;
		out.physicsMaterial = tri.physicsMaterial;
		out.effectMaterial = tri.effectMaterial;
		out.userData = tri.userData;
		out.normalPacked = tri.normalPacked;
		out.normal = normalise(tri.normal);
		out.contact = contact;
		out.distance = length(ray.start - contact);
		out.segmentEnd = contact;
		return true;
	}

	// -------------------------------------------------------------- sphere query

	void sphere_query_mesh(const Mesh& mesh, const Vec3& centre, float radius,
	                       const CollisionFilter& filter, SphereResult& out)
	{
		out = SphereResult();
		const float radiusSq = radius * radius;

		struct Patch
		{
			Vec3 normal;
			std::uint32_t numPoints = 0;
		};
		Patch patches[SphereResult::kMaxPatches];
		std::uint32_t numPatches = 0;

		const CRAxisBox sphereBox{centre, Vec3(radius, radius, radius)};

		std::uint32_t stack[kStackSlots];
		std::uint32_t size = 1;
		stack[0] = 0;
		std::uint32_t topNode = 0;

		while (size != 0)
		{
			--size;
			const std::uint32_t nodeIndex = topNode;
			const std::uint32_t popIndex = (size > 0) ? (size - 1) : 0;
			topNode = stack[popIndex];

			if (nodeIndex >= mesh.numNodes)
				break;
			const NodeRecord& node = mesh.nodes[nodeIndex];

			if (!box_intersects_minmax(node.box, sphereBox))
				continue;

			if (node.triangleSizeIndices == 0)
			{
				if (size + 2 > kStackSlots)
					break;
				stack[size] = nodeIndex + node.startOrRightOffset;
				++size;
				stack[size] = nodeIndex + 1;
				++size;
				topNode = nodeIndex + 1;
				continue;
			}

			std::uint32_t a = 0;
			std::uint32_t offset = 0;
			std::uint32_t headerSlot = 0;
			const std::uint32_t headerFirst = headers_of(node).first;

			while (a < node.triangleSizeIndices)
			{
				if (headerSlot >= mesh.headers.size())
					break;
				const HeaderRecord& header = mesh.headers[headerFirst + headerSlot];
				const std::uint32_t numTris = header.numTriangles;
				offset += kHeaderBytes;
				const std::uint32_t groupOffset = offset;

				if (!filter.can_collide(header.collisionFlags))
				{
					++out.headersFiltered;
					offset = groupOffset + numTris * kTriangleBytes;
					a += numTris;
					++headerSlot;
					continue;
				}

				const std::uint32_t count = (a + numTris > node.triangleSizeIndices)
					? (node.triangleSizeIndices - a) : numTris;
				for (std::uint32_t i = 0; i < count; ++i)
				{
					const TriangleRecord& tri = mesh.triangles[header.firstTriangle + i];
					const Vec3 a0 = decode_cached_vertex(mesh, node, tri.indexA);
					const Vec3 b0 = decode_cached_vertex(mesh, node, tri.indexB);
					const Vec3 c0 = decode_cached_vertex(mesh, node, tri.indexC);
					const Vec3 norm = -decode_hen_dn3(tri.normalPacked);

					Vec3 contactPoint;
					closest_point_triangle(centre, a0, b0, c0, contactPoint);
					const Vec3 d = contactPoint - centre;
					if (dot(d, d) > radiusSq)
						continue;

					const Vec3 surfaceNormal = normalise(d);
					out.hit = true;

					Patch* patch = nullptr;
					std::uint32_t incr = 0;
					if (numPatches < SphereResult::kMaxPatches)
					{
						patch = &patches[numPatches];
						patch->numPoints = 0;
						patch->normal = surfaceNormal;
						incr = 1;
					}
					for (std::uint32_t j = 0; j < numPatches; ++j)
					{
						if (dot(patches[j].normal, surfaceNormal) >= close_normal())
						{
							patch = &patches[j];
							incr = 0;
							break;
						}
					}
					if (patch == nullptr)
						continue;
					numPatches += incr;

					const float penetration = radius - dot(d, norm);
					if (patch->numPoints < SphereResult::kMaxContacts)
					{
						SphereContact contact;
						contact.point = contactPoint;
						contact.surfaceNormal = surfaceNormal;
						contact.penetration = penetration;
						contact.engineHashValue = groupOffset + i;
						contact.triangleOrdinal = tri.ordinalInLeaf;
						contact.physicsMaterial = header.physicsMaterial;
						contact.effectMaterial = header.effectMaterial;
						contact.patchIndex = static_cast<std::uint32_t>(patch - patches);
						++patch->numPoints;
						out.contacts.push_back(contact);
					}
				}

				offset = groupOffset + numTris * kTriangleBytes;
				a += numTris;
				++headerSlot;
			}
		}

		out.patchCount = numPatches;
	}

	std::uint32_t total_triangle_count(const Level& level)
	{
		std::uint32_t total = 0;
		for (const Mesh& mesh : level.meshes)
			total += static_cast<std::uint32_t>(mesh.triangles.size());
		return total;
	}

	bool global_triangle(const Level& level, std::uint32_t ordinal, GlobalTriangle& out)
	{
		std::uint32_t remaining = ordinal;
		for (const Mesh& mesh : level.meshes)
		{
			const std::uint32_t count = static_cast<std::uint32_t>(mesh.triangles.size());
			if (remaining >= count)
			{
				remaining -= count;
				continue;
			}
			const TriangleRecord& tri = mesh.triangles[remaining];
			const LeafRecord& leaf = mesh.leaves[tri.leafIndex];
			const NodeRecord& node = mesh.nodes[leaf.nodeIndex];
			out.meshIndex = mesh.index;
			out.leafIndex = leaf.nodeIndex;
			out.ordinalInLeaf = tri.ordinalInLeaf;
			out.recordIndex = remaining;
			out.a = decode_cached_vertex(mesh, node, tri.indexA);
			out.b = decode_cached_vertex(mesh, node, tri.indexB);
			out.c = decode_cached_vertex(mesh, node, tri.indexC);
			out.normalPacked = tri.normalPacked;
			out.normal = decode_hen_dn3(tri.normalPacked);
			return true;
		}
		return false;
	}
}
