#include "oracle_run.h"

#include <cstring>

#include "level_physics.h"
#include "probe_io.h"
#include "queries.h"
#include "query_table.h"

namespace oracle
{
	namespace
	{
		std::string json_error(const RunOptions& options, const LoadError& err)
		{
			Json j;
			j.begin_object();
			j.key("probe"); j.value_string("collision-oracle");
			j.key("formatVersion"); j.value_u32(1);
			j.key("status"); j.value_string("error");
			j.key("input");
			j.begin_object();
			j.key("label"); j.value_string(options.inputLabel);
			j.end_object();
			j.key("error");
			j.begin_object();
			j.key("code"); j.value_string(err.code);
			j.key("offset"); j.value_u64(err.offset);
			j.key("detail"); j.value_string(err.detail);
			j.end_object();
			j.key("scope");
			j.begin_object();
			j.key("engineIntegration"); j.value_bool(false);
			j.key("vehiclePhysics"); j.value_bool(false);
			j.key("gameRun"); j.value_bool(false);
			j.end_object();
			j.key("build");
			j.begin_object();
			j.key("target"); j.value_string(options.target);
			j.key("flags"); j.value_string(options.flags);
			j.end_object();
			j.end_object();
			return j.str();
		}

		std::string hash_bytes(const std::vector<std::uint8_t>& bytes)
		{
			return sha256_hex(bytes.empty() ? nullptr : bytes.data(), bytes.size());
		}

		std::string hash_vec3(const std::vector<Vec3>& values)
		{
			Bin b;
			for (const Vec3& v : values) b.vec3(v.x, v.y, v.z);
			return hash_bytes(b.data());
		}
	}

	namespace
	{
		void emit_vec3(Json& j, const Vec3& v)
		{
			j.begin_object();
			j.key("x"); j.value_bits(v.x);
			j.key("y"); j.value_bits(v.y);
			j.key("z"); j.value_bits(v.z);
			j.end_object();
		}

		void append_ray_record(Bin& b, std::uint32_t index, const RayResult& r, std::uint32_t bodiesTested)
		{
			b.u8(1);
			b.u8(r.hit ? 1 : 0);
			b.u16(0);
			b.u32(index);
			b.u32(r.hit ? r.meshIndex : 0xFFFFFFFFu);
			b.u32(r.hit ? r.leafIndex : 0xFFFFFFFFu);
			b.u32(r.hit ? r.triangleOrdinal : 0xFFFFFFFFu);
			b.u32(r.hit ? r.engineTriangleIndex : 0xFFFFFFFFu);
			b.u32(r.hit ? r.headerIndex : 0xFFFFFFFFu);
			b.u32(r.hit ? r.collisionFlags : 0u);
			b.u32(r.hit ? r.physicsMaterial : 0u);
			b.u32(r.hit ? r.effectMaterial : 0u);
			b.u32(r.hit ? r.userData : 0u);
			b.u32(r.hit ? r.normalPacked : 0u);
			b.vec3(r.contact.x, r.contact.y, r.contact.z);
			b.vec3(r.normal.x, r.normal.y, r.normal.z);
			b.f32(r.hit ? r.distance : 0.0f);
			b.u32(bodiesTested);
		}

		void emit_ray_json(Json& j, const RayQueryEntry& e, const RayResult& r, std::uint32_t bodiesTested,
		                   const std::string& recordHex)
		{
			j.begin_object();
			j.key("label"); j.value_string(e.label);
			j.key("hit"); j.value_bool(r.hit);
			j.key("mesh"); j.value_u32(r.hit ? r.meshIndex : 0xFFFFFFFFu);
			j.key("leaf"); j.value_u32(r.hit ? r.leafIndex : 0xFFFFFFFFu);
			j.key("triangleOrdinal"); j.value_u32(r.hit ? r.triangleOrdinal : 0xFFFFFFFFu);
			j.key("engineTriangleIndex"); j.value_u32(r.hit ? r.engineTriangleIndex : 0xFFFFFFFFu);
			j.key("header"); j.value_u32(r.hit ? r.headerIndex : 0xFFFFFFFFu);
			j.key("collisionFlags"); j.value_u32(r.hit ? r.collisionFlags : 0u);
			j.key("physicsMaterial"); j.value_u32(r.hit ? r.physicsMaterial : 0u);
			j.key("effectMaterial"); j.value_u32(r.hit ? r.effectMaterial : 0u);
			j.key("userData"); j.value_u32(r.hit ? r.userData : 0u);
			j.key("normalPacked"); j.value_hex(r.hit ? r.normalPacked : 0u);
			j.key("start"); emit_vec3(j, e.ray.start);
			j.key("direction"); emit_vec3(j, e.ray.direction);
			j.key("maxCosAngle"); j.value_bits(e.ray.maxCosAngle);
			j.key("maxDistance"); j.value_bits(e.ray.maxDistance);
			j.key("bodiesTested"); j.value_u32(bodiesTested);
			j.key("contact"); emit_vec3(j, r.contact);
			j.key("normal"); emit_vec3(j, r.normal);
			j.key("distance"); j.value_bits(r.distance);
			j.key("record"); j.value_string(recordHex);
			j.end_object();
		}

		void emit_mesh(Json& j, const Mesh& m)
		{
			j.begin_object();
			j.key("index"); j.value_u32(m.index);
			j.key("numVertices"); j.value_u32(m.numVertices);
			j.key("numNormals"); j.value_u32(m.numNormals);
			j.key("numTriangles"); j.value_u32(static_cast<std::uint32_t>(m.triangles.size()));
			j.key("numLeaves"); j.value_u32(static_cast<std::uint32_t>(m.leaves.size()));
			j.key("numNodes"); j.value_u32(m.numNodes);
			j.key("numHeaders"); j.value_u32(static_cast<std::uint32_t>(m.headers.size()));
			j.key("numActiveEdges"); j.value_u32(m.numActiveEdges);
			j.key("triangleCapacityBytes"); j.value_u32(m.triangleCapacityBytes);
			j.key("triangleBufferBytes"); j.value_u32(m.triangleBufferBytes);
			j.key("low"); emit_vec3(j, m.low);
			j.key("high"); emit_vec3(j, m.high);
			j.key("marginBits"); j.value_bits(m.margin);
			j.key("epsilonBits"); j.value_bits(m.epsilon);
			j.key("physicsMaterialIndex"); j.value_u32(m.physicsMaterialIndex);
			j.key("effectMaterialIndex"); j.value_u32(m.effectMaterialIndex);
			j.key("collisionFlag"); j.value_hex(m.collisionFlag);
			j.key("nodeFlag"); j.value_u32(m.nodeFlag);
			j.key("massBits"); j.value_bits(m.mass);
			j.key("originalExportID"); j.value_u32(m.originalExportID);
			j.key("renderOffset"); emit_vec3(j, m.renderOffset);
			j.key("remapped"); j.value_u32(m.remapped);
			j.key("userDataFlag"); j.value_u32(m.userDataFlag);
			j.key("identityInstance"); j.value_bool(m.isIdentityInstance());
			j.key("instancePosition"); emit_vec3(j, m.instancePosition);
			j.key("streamBegin"); j.value_u64(m.streamBegin);
			j.key("streamEnd"); j.value_u64(m.streamEnd);
			j.key("instanceBegin"); j.value_u64(m.instanceBegin);
			j.key("vertexStreamHash"); j.value_string(hash_vec3(m.vertexStream));
			{
				Bin b;
				for (std::int16_t v : m.vertexS16) b.u16(static_cast<std::uint16_t>(v));
				j.key("vertexQuantisedHash"); j.value_string(hash_bytes(b.data()));
			}
			{
				Bin b;
				for (std::uint32_t n : m.normals) b.u32(n);
				j.key("normalHash"); j.value_string(hash_bytes(b.data()));
			}
			{
				Bin b;
				for (const NodeRecord& n : m.nodes)
				{
					b.f32(n.box.min.x); b.f32(n.box.min.y); b.f32(n.box.min.z);
					b.f32(n.box.max.x); b.f32(n.box.max.y); b.f32(n.box.max.z);
					b.u32(n.triangleSizeIndices);
					b.u32(n.startOrRightOffset);
					b.u32(n.vertexStart);
					b.u32(n.numVertices);
					b.u32(n.triangleBufferStart);
					b.u32(n.triangleBufferLength);
				}
				j.key("nodeHash"); j.value_string(hash_bytes(b.data()));
			}
			{
				Bin b;
				for (const TriangleRecord& t : m.triangles)
				{
					b.u8(t.indexA); b.u8(t.indexB); b.u8(t.indexC);
					b.u32(t.normalPacked); b.u32(t.activeEdgeDataIndex);
					b.u32(t.leafIndex); b.u32(t.ordinalInLeaf); b.u32(t.bufferOffsetInLeaf);
				}
				j.key("triangleHash"); j.value_string(hash_bytes(b.data()));
			}
			j.end_object();
		}
	}

	std::string run(const std::uint8_t* data, std::size_t size, const RunOptions& options)
	{
		Level level;
		LoadError err;
		if (!load_level(data, size, level, err))
			return json_error(options, err);

		const QueryTable table = build_query_table(level);

		Bin canonical;
		Json j;
		j.begin_object();
		j.key("probe"); j.value_string("collision-oracle");
		j.key("formatVersion"); j.value_u32(1);
		j.key("status"); j.value_string("ok");

		j.key("scope");
		j.begin_object();
		j.key("engineIntegration"); j.value_bool(false);
		j.key("vehiclePhysics"); j.value_bool(false);
		j.key("gameRun"); j.value_bool(false);
		j.key("codeSource"); j.value_string("upstream/BlurRebuilt Gravity static mesh query paths");
		j.key("meshImport"); j.value_string("E_ImportTriangleMesh_Shape, gravity stream v10");
		j.key("rayRadius"); j.value_bits(0.0f);
		j.key("fatTrace"); j.value_string("unsupported");
		j.key("sphereQuery"); j.value_string("CollideSphereTriangleMesh<6,16>");
		j.key("normalisation"); j.value_string("exact-ieee-1/sqrt");
		j.key("sphereDecode"); j.value_string("HenDN3 11-11-10 signed normalised");
		j.key("filter"); j.value_string("C_CollisionFilter() defaults (accept-all mask)");
		j.key("floatEncoding"); j.value_string("binary32 little-endian bit pattern, 8 hex digits");
		j.key("sceneRule"); j.value_string("ray: first mesh body with a hit; fill: mesh body order, 4-entry cache");
		j.key("instanceTransforms"); j.value_string("none (C_ShapeInstance is reported, not applied)");
		j.end_object();

		j.key("input");
		j.begin_object();
		j.key("label"); j.value_string(options.inputLabel);
		j.key("size"); j.value_u64(size);
		j.key("sha256"); j.value_string(sha256_hex(data, size));
		j.end_object();

		j.key("file");
		j.begin_object();
		j.key("marker"); j.value_string(level.marker);
		j.key("rootId"); j.value_string(level.root.id);
		j.key("rootOffset"); j.value_u64(level.root.offset);
		j.key("rootSize"); j.value_u32(level.root.size);
		j.key("rootType"); j.value_i32(level.root.type);
		j.key("rootCount"); j.value_u32(level.root.count);
		j.key("headerOffset"); j.value_u64(level.headerBlock.offset);
		j.key("headerSize"); j.value_u32(level.headerBlock.size);
		j.key("mainOffset"); j.value_u64(level.mainBlock.offset);
		j.key("mainSize"); j.value_u32(level.mainBlock.size);
		j.key("routesPresent"); j.value_bool(level.haveRoutes);
		j.key("routesOffset"); j.value_u64(level.routesBlock.offset);
		j.key("routesSize"); j.value_u32(level.routesBlock.size);
		j.key("routesParsed"); j.value_bool(false);
		j.key("physicsFileVersion"); j.value_u32(level.physicsFileVersion);
		j.key("routeCount"); j.value_i32(level.routeCount);
		j.key("gravityStreamVersion"); j.value_u32(level.gravityStreamVersion);
		j.key("gravityStreamType"); j.value_u32(level.gravityStreamType);
		j.key("shapeStreamEnd"); j.value_u64(level.shapeStreamEnd);
		j.key("constraintTerminatorOffset"); j.value_u64(level.constraintTerminatorOffset);
		j.key("meshCount"); j.value_u32(static_cast<std::uint32_t>(level.meshes.size()));
		j.end_object();

		j.key("bounds");
		j.begin_object();
		j.key("min"); emit_vec3(j, level.boundsMin());
		j.key("max"); emit_vec3(j, level.boundsMax());
		j.end_object();

		j.key("meshes");
		j.begin_array();
		for (const Mesh& m : level.meshes) emit_mesh(j, m);
		j.end_array();

		// ---- rays ----------------------------------------------------------
		j.key("rays");
		j.begin_array();
		for (std::uint32_t i = 0; i < table.rays.size(); ++i)
		{
			std::uint32_t bodiesTested = 0;
			const RayResult r = ray_trace_scene(level, table.rays[i].ray, bodiesTested);
			Bin record;
			append_ray_record(record, i, r, bodiesTested);
			canonical.data().insert(canonical.data().end(), record.data().begin(), record.data().end());
			emit_ray_json(j, table.rays[i], r, bodiesTested, hex_bytes(record.data()));
		}
		j.end_array();

		// ---- spheres -------------------------------------------------------
		j.key("spheres");
		j.begin_array();
		for (std::uint32_t i = 0; i < table.spheres.size(); ++i)
		{
			const SphereQueryEntry& e = table.spheres[i];
			bool anyHit = false;
			std::uint32_t totalContacts = 0;
			std::uint32_t headersFiltered = 0;
			Bin record;
			record.u8(2);
			std::size_t hitPos = record.data().size();
			record.u8(0); // patched after the per-body loop
			record.u16(0);
			record.u32(i);
			record.f32(e.radius);
			record.vec3(e.centre.x, e.centre.y, e.centre.z);

			Bin bodyData;
			for (const Mesh& mesh : level.meshes)
			{
				SphereResult sr;
				sphere_query_mesh(mesh, e.centre, e.radius, CollisionFilter(), sr);
				anyHit = anyHit || sr.hit;
				headersFiltered += sr.headersFiltered;
				for (const SphereContact& c : sr.contacts)
				{
					++totalContacts;
					bodyData.u32(mesh.index);
					bodyData.u32(c.triangleOrdinal);
					bodyData.u32(c.engineHashValue);
					bodyData.u32(c.patchIndex);
					bodyData.u32(c.physicsMaterial);
					bodyData.u32(c.effectMaterial);
					bodyData.vec3(c.point.x, c.point.y, c.point.z);
					bodyData.vec3(c.surfaceNormal.x, c.surfaceNormal.y, c.surfaceNormal.z);
					bodyData.f32(c.penetration);
				}
			}

			record.data()[hitPos] = anyHit ? 1u : 0u;
			record.u32(headersFiltered);
			record.u32(totalContacts);
			record.data().insert(record.data().end(), bodyData.data().begin(), bodyData.data().end());

			canonical.data().insert(canonical.data().end(), record.data().begin(), record.data().end());

			j.begin_object();
			j.key("label"); j.value_string(e.label);
			j.key("hit"); j.value_bool(anyHit);
			j.key("centre"); emit_vec3(j, e.centre);
			j.key("radius"); j.value_bits(e.radius);
			j.key("headersFiltered"); j.value_u32(headersFiltered);
			j.key("contactCount"); j.value_u32(totalContacts);
			j.key("record"); j.value_string(hex_bytes(record.data()));
			j.end_object();
		}
		j.end_array();

		// ---- cache fills ---------------------------------------------------
		j.key("cacheQueries");
		j.begin_array();
		for (std::uint32_t i = 0; i < table.cacheQueries.size(); ++i)
		{
			const CacheQueryEntry& e = table.cacheQueries[i];
			LineCache cache;
			CacheFillStats stats;
			fill_line_cache(level, e.box, CollisionFilter(), e.negativeNormal, e.maxCosAngle, cache, stats);
			RayResult trace;
			cache_trace(cache, e.trace, trace);

			Bin record;
			record.u8(3);
			record.u8(trace.hit ? 1 : 0);
			record.u16(0);
			record.u32(i);
			record.u32(cache.high);
			record.u32(stats.bodiesConsidered);
			record.u32(stats.bodiesAccepted);
			record.u32(stats.headersFiltered);
			record.u32(stats.trianglesTested);
			record.u32(stats.trianglesRejectedByNormal);
			for (std::uint32_t k = 0; k < cache.high; ++k)
			{
				const CacheTriangle& t = cache.entries[k];
				record.u32(t.engineTriangleIndex);
				record.u32(t.triangleOrdinal);
				record.u32(t.leafIndex);
				record.u32(t.collisionFlags);
				record.u32(t.physicsMaterial);
				record.u32(t.effectMaterial);
				record.u32(t.userData);
				record.u32(t.normalPacked);
				record.vec3(t.a.x, t.a.y, t.a.z);
				record.vec3(t.b.x, t.b.y, t.b.z);
				record.vec3(t.c.x, t.c.y, t.c.z);
			}
			record.u32(trace.hit ? trace.engineTriangleIndex : 0xFFFFFFFFu);
			record.u32(trace.hit ? trace.triangleOrdinal : 0xFFFFFFFFu);
			record.u32(trace.hit ? trace.leafIndex : 0xFFFFFFFFu);
			record.u32(trace.hit ? trace.collisionFlags : 0u);
			record.u32(trace.hit ? trace.physicsMaterial : 0u);
			record.u32(trace.hit ? trace.effectMaterial : 0u);
			record.u32(trace.hit ? trace.userData : 0u);
			record.u32(trace.hit ? trace.normalPacked : 0u);
			record.vec3(trace.contact.x, trace.contact.y, trace.contact.z);
			record.vec3(trace.normal.x, trace.normal.y, trace.normal.z);
			record.f32(trace.hit ? trace.distance : 0.0f);

			canonical.data().insert(canonical.data().end(), record.data().begin(), record.data().end());

			j.begin_object();
			j.key("label"); j.value_string(e.label);
			j.key("cachedTriangles"); j.value_u32(cache.high);
			j.key("bodiesConsidered"); j.value_u32(stats.bodiesConsidered);
			j.key("bodiesAccepted"); j.value_u32(stats.bodiesAccepted);
			j.key("headersFiltered"); j.value_u32(stats.headersFiltered);
			j.key("trianglesTested"); j.value_u32(stats.trianglesTested);
			j.key("trianglesRejectedByNormal"); j.value_u32(stats.trianglesRejectedByNormal);
			j.key("traceHit"); j.value_bool(trace.hit);
			j.key("traceTriangleIndex"); j.value_u32(trace.hit ? trace.engineTriangleIndex : 0xFFFFFFFFu);
			j.key("record"); j.value_string(hex_bytes(record.data()));
			j.end_object();
		}
		j.end_array();

		j.key("hashes");
		j.begin_object();
		j.key("queryHash"); j.value_string(hash_bytes(canonical.data()));
		j.key("canonicalRecordBytes"); j.value_u32(static_cast<std::uint32_t>(canonical.data().size()));
		j.end_object();

		j.key("counts");
		j.begin_object();
		j.key("rays"); j.value_u32(static_cast<std::uint32_t>(table.rays.size()));
		j.key("spheres"); j.value_u32(static_cast<std::uint32_t>(table.spheres.size()));
		j.key("cacheQueries"); j.value_u32(static_cast<std::uint32_t>(table.cacheQueries.size()));
		j.key("totalTriangles"); j.value_u32(total_triangle_count(level));
		j.end_object();

		j.key("build");
		j.begin_object();
		j.key("target"); j.value_string(options.target);
		j.key("flags"); j.value_string(options.flags);
		j.end_object();

		j.end_object();
		return j.str();
	}

	std::string selftest()
	{
		// 1. HVec quantisation round-trip bounds.
		if (encode_fixed_s16_14(1.0f) != 16384 || encode_fixed_s16_14(-1.0f) != -16384)
			return "fixed3_s16_14 encode of +/-1";
		if (decode_fixed_s16_14(16384) != 1.0f || decode_fixed_s16_14(-16384) != -1.0f)
			return "fixed3_s16_14 decode of +/-16384";
		if (encode_fixed_s16_14(0.5f) != 8192)
			return "fixed3_s16_14 encode of 0.5";

		// 2. HenDN3 decode of the axis normals.
		{
			const std::uint32_t posX = 1023u;           // x = 1023, y = 0, z = 0
			const std::uint32_t posY = 1023u << 11;     // y = 1023
			const std::uint32_t posZ = 511u << 22;      // z = 511
			const Vec3 x = decode_hen_dn3(posX);
			const Vec3 y = decode_hen_dn3(posY);
			const Vec3 z = decode_hen_dn3(posZ);
			if (x.x != 1.0f || x.y != 0.0f || x.z != 0.0f) return "HenDN3 +X";
			if (y.x != 0.0f || y.y != 1.0f || y.z != 0.0f) return "HenDN3 +Y";
			if (z.x != 0.0f || z.y != 0.0f || z.z != 1.0f) return "HenDN3 +Z";
			const Vec3 negX = decode_hen_dn3(static_cast<std::uint32_t>(-1023) & 0x7FFu);
			if (negX.x != -1.0f) return "HenDN3 -X";
		}

		// 3. Ray/box and triangle/segment helpers.
		{
			AxisBoxMinMax box;
			box.min = Vec3(-1.0f, -1.0f, -1.0f);
			box.max = Vec3(1.0f, 1.0f, 1.0f);
			if (!intersect_ray_aabb(Vec3(0.0f, 5.0f, 0.0f), Vec3(0.0f, -5.0f, 0.0f), box.min, box.max))
				return "intersect_ray_aabb hit";
			if (intersect_ray_aabb(Vec3(5.0f, 5.0f, 0.0f), Vec3(5.0f, -5.0f, 0.0f), box.min, box.max))
				return "intersect_ray_aabb miss";

			Vec3 hit;
			if (!intersect_triangle_segment(Vec3(-1.0f, 0.0f, -1.0f), Vec3(1.0f, 0.0f, -1.0f),
			                                Vec3(0.0f, 0.0f, 1.0f),
			                                Vec3(0.0f, 5.0f, 0.0f), Vec3(0.0f, -5.0f, 0.0f), hit))
				return "intersect_triangle_segment hit";
			if (hit.x != 0.0f || hit.z != 0.0f) return "intersect_triangle_segment contact";
			Vec3 miss;
			if (intersect_triangle_segment(Vec3(-1.0f, 0.0f, -1.0f), Vec3(1.0f, 0.0f, -1.0f),
			                               Vec3(0.0f, 0.0f, 1.0f),
			                               Vec3(4.0f, 5.0f, 0.0f), Vec3(4.0f, -5.0f, 0.0f), miss))
				return "intersect_triangle_segment miss";
		}

		// 4. Closest point on a triangle.
		{
			Vec3 c;
			closest_point_triangle(Vec3(0.0f, 2.0f, 0.0f), Vec3(-1.0f, 0.0f, -1.0f),
			                       Vec3(1.0f, 0.0f, -1.0f), Vec3(0.0f, 0.0f, 1.0f), c);
			if (c.x != 0.0f || c.y != 0.0f || c.z != 0.0f) return "closest_point_triangle interior";
			closest_point_triangle(Vec3(5.0f, 1.0f, -1.0f), Vec3(-1.0f, 0.0f, -1.0f),
			                       Vec3(1.0f, 0.0f, -1.0f), Vec3(0.0f, 0.0f, 1.0f), c);
			if (c.x != 1.0f || c.y != 0.0f || c.z != -1.0f) return "closest_point_triangle edge";
		}

		// 5. SHA-256 known vector.
		{
			const char* abc = "abc";
			if (sha256_hex(reinterpret_cast<const std::uint8_t*>(abc), 3) !=
			    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
				return "sha256(abc)";
		}

		// 6. Malformed input is rejected with an offset, never accepted.
		{
			std::uint8_t bytes[20];
			std::memset(bytes, 0, sizeof(bytes));
			Level level;
			LoadError err;
			if (load_level(bytes, sizeof(bytes), level, err))
				return "all-zero input accepted";
			if (err.code.empty() || err.offset != 0)
				return "all-zero input error location";
		}

		return std::string();
	}
}
