// T-005d gravity overlay spike: run the REAL Gravity static-collision query
// code on Level.levelphysics and emit the collision-oracle canonical records.
//
// Harness code, not engine code. It links upstream Gravity TUs unmodified (see
// engine/verify_gravity.py) and only:
//   * finds the `Main` block of the PC block stream with a bounded read (the
//     framing proven in docs/work/analysis/t005-collision-oracle.md),
//   * hands the import stream to Gravity's own
//     OptimisedAABBTree::DeSerialise through Sys::C_MemoryStream,
//   * rebuilds the probe's fixed query fixture from the decoded tree,
//   * calls the engine's own FillLineCollisionCache, C_LineCollisionCache::Trace,
//     OptimisedAABBTree::RayTracing<CollideRayTriangleMesh> and
//     OptimisedAABBTree::Collide<6,16,CollideSphereTriangleMesh>,
//   * wraps the template collision callbacks so the leaf/group the engine
//     selected can be reported (the public result does not expose it), and
//   * serialises the same canonical binary records as probes/collision-oracle.
//
// Every record field is produced by engine code except the fixture inputs and
// the cache counters, which the engine does not expose; the counters are
// derived by a scan that must reproduce the engine's cached triangle set
// exactly or the run fails (status "error").

#include "stdafx.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "gravity/narrowphase/OptimisedAABBTree.h"
#include "gravity/narrowphase/AxisBox.inl"
#include "gravity/narrowphase/Primitive.inl"
#include "gravity/narrowphase/Shapes.h"
#include "gravity/narrowphase/LineCollisionCache.h"
#include "gravity/narrowphase/OptimisedAABBTree.inl"
#include "gravity/narrowphase/RayTriangle.inl"
#include "gravity/narrowphase/SphereTriangle.inl"
#include "system/serialise/C_MemoryStream.h"

#include "probe_io.h"

namespace spike
{
	using namespace Collision;
	using probe::Bin;

	// ------------------------------------------------------------------ helpers

	static std::uint32_t pb(float v) { return probe::f32_bits(v); }

	struct F3
	{
		float x, y, z;
		F3() : x(0.0f), y(0.0f), z(0.0f) {}
		F3(float a, float b, float c) : x(a), y(b), z(c) {}
	};

	static F3 from_hvec(const Maths::HVec3& v) { return F3(v.X(), v.Y(), v.Z()); }
	static Maths::HVec3 to_hvec(const F3& v) { return Maths::HVec3(v.x, v.y, v.z); }
	static F3 add(const F3& a, const F3& b) { return F3(a.x + b.x, a.y + b.y, a.z + b.z); }
	static F3 mul(const F3& a, float s) { return F3(a.x * s, a.y * s, a.z * s); }
	static float dot(const F3& a, const F3& b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
	static F3 centroid(const F3& a, const F3& b, const F3& c)
	{
		return F3((a.x + b.x + c.x) / 3.0f, (a.y + b.y + c.y) / 3.0f, (a.z + b.z + c.z) / 3.0f);
	}
	static F3 normalized_or_up(const F3& d)
	{
		const float len2 = dot(d, d);
		if (!(len2 > 1.0e-6f))
			return F3(0.0f, 1.0f, 0.0f);
		const float len = std::sqrt(len2);
		return F3(d.x / len, d.y / len, d.z / len);
	}
	static F3 lerp_bounds(const F3& lo, const F3& hi, float ux, float uy, float uz)
	{
		return F3(lo.x + (hi.x - lo.x) * ux, lo.y + (hi.y - lo.y) * uy, lo.z + (hi.z - lo.z) * uz);
	}

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
		float unit() { return static_cast<float>(next() >> 8) * (1.0f / 16777216.0f); }
	private:
		std::uint32_t m_state;
	};

	// Copy of Collision::IntersectAABBTriangle(C_CRAxisBox&, ...)
	// (gravity/include/gravity/narrowphase/OptimisedAABBTree_FillCache.inl:12-85).
	// The definition lives in a header that also defines the non-inline
	// FillLineCollisionCache, so the harness cannot include it in a second TU.
	// This copy is used only by the derived cache-counter scan; the cached
	// triangle set and the trace come from the engine and must agree with it.
	static bool HarnessIntersectAABBTriangle(C_CRAxisBox& box, const Maths::HVec3& a,
	                                         const Maths::HVec3& b, const Maths::HVec3& c)
	{
		using namespace Maths;
		const Maths::HF32 half(Maths::Constants<Maths::HF32>::Half());
		(void)half;
		const HVec3 ca(box.centre);
		const HVec3 e(box.extents);

		const HVec3 v0(a - ca);
		const HVec3 v1(b - ca);
		const HVec3 v2(c - ca);

		const HVec3 f0(v1 - v0);
		const HVec3 f1(v2 - v1);
		const HVec3 f2(v0 - v2);

		const HVec3 absF0(Maths::Abs(f0));
		const HVec3 crossP00(v0 ^ f0);
		const HVec3 crossP01(v2 ^ f0);

		const HVec3 crossRA0(e.Y() * absF0.Z() + e.Z() * absF0.Y(),
		                     e.X() * absF0.Z() + e.Z() * absF0.X(),
		                     e.X() * absF0.Y() + e.Y() * absF0.X());

		const Maths::HVec3 vMin0(Maths::Min(crossP00, crossP01));
		const Maths::HVec3 vMax0(Maths::Max(crossP00, crossP01));

		if (Maths::AnyTrue3((vMax0 < (-crossRA0)) | (vMin0 > crossRA0)))
			return false;

		const HVec3 absF1(Maths::Abs(f1));
		const HVec3 crossP10(v0 ^ f1);
		const HVec3 crossP11(v1 ^ f1);

		const HVec3 crossRA1(e.Y() * absF1.Z() + e.Z() * absF1.Y(),
		                     e.X() * absF1.Z() + e.Z() * absF1.X(),
		                     e.X() * absF1.Y() + e.Y() * absF1.X());

		const HVec3 vMax1(Max(crossP10, crossP11));
		const HVec3 vMin1(Min(crossP10, crossP11));

		if (Maths::AnyTrue3((vMax1 < (-crossRA1)) | (vMin1 > crossRA1)))
			return false;

		const HVec3 absF2(Maths::Abs(f2));
		const HVec3 crossP20(v0 ^ f2);
		const HVec3 crossP21(v1 ^ f2);

		const HVec3 vMax2(Max(crossP20, crossP21));
		const HVec3 vMin2(Min(crossP20, crossP21));

		const HVec3 crossRA2(e.Y() * absF2.Z() + e.Z() * absF2.Y(),
		                     e.X() * absF2.Z() + e.Z() * absF2.X(),
		                     e.X() * absF2.Y() + e.Y() * absF2.X());

		if (Maths::AnyTrue3((vMax2 < (-crossRA2)) | (vMin2 > crossRA2)))
			return false;

		const HVec3 n(f0 ^ f1);
		const HF32 d(n | v0);
		const HVec3 absn(Abs(n));
		const HF32 r(e | absn);
		return Abs(d).LE(r);
	}

	// ------------------------------------------------------------------ loader

	struct LoadError
	{
		bool ok = true;
		std::string code;
		std::string detail;
		std::uint64_t offset = 0;
	};

	static void fail(LoadError& e, const char* code, std::uint64_t at, const char* detail)
	{
		e.ok = false; e.code = code; e.offset = at; e.detail = detail;
	}

	struct BlockInfo
	{
		std::uint64_t offset = 0;
		char id[9] = {};
		std::uint32_t size = 0;
		std::uint16_t count = 0;
	};

	class Cursor
	{
	public:
		Cursor(const std::uint8_t* d, std::size_t n) : m_d(d), m_n(n), m_p(0) {}
		std::uint64_t pos() const { return m_p; }
		void seek(std::uint64_t p) { m_p = p; }
		std::uint64_t end() const { return m_n; }
		bool need(std::uint64_t n, LoadError& e, const char* code)
		{
			if (m_p + n > m_n) { fail(e, code, m_p, "read past end"); return false; }
			return true;
		}
		bool u8(std::uint8_t& v, LoadError& e)
		{
			if (!need(1, e, "read_u8")) return false;
			v = m_d[m_p++]; return true;
		}
		bool u16(std::uint16_t& v, LoadError& e)
		{
			if (!need(2, e, "read_u16")) return false;
			std::memcpy(&v, m_d + m_p, 2); m_p += 2; return true;
		}
		bool u32(std::uint32_t& v, LoadError& e)
		{
			if (!need(4, e, "read_u32")) return false;
			std::memcpy(&v, m_d + m_p, 4); m_p += 4; return true;
		}
	private:
		const std::uint8_t* m_d;
		std::size_t m_n;
		std::uint64_t m_p;
	};

	static bool read_block(Cursor& c, BlockInfo& b, LoadError& e)
	{
		const std::uint64_t at = c.pos();
		if (!c.need(16, e, "block_header_truncated")) return false;
		for (int i = 0; i < 8; ++i) { std::uint8_t ch = 0; if (!c.u8(ch, e)) return false; b.id[i] = static_cast<char>(ch); }
		b.id[8] = 0;
		std::uint8_t type = 0, comp = 0;
		if (!c.u32(b.size, e) || !c.u16(b.count, e) || !c.u8(type, e) || !c.u8(comp, e)) return false;
		b.offset = at;
		if (b.size < 16) { fail(e, "block_size_too_small", at, "size < 16"); return false; }
		if (at + b.size > c.end()) { fail(e, "block_overruns_parent", at, "block ends past parent"); return false; }
		return true;
	}

	struct TriInfo
	{
		std::uint8_t a = 0, b = 0, c = 0;
		std::uint32_t normal = 0;
		std::uint32_t ordinal = 0;
	};

	struct GroupInfo
	{
		std::uint32_t offset = 0;
		std::uint32_t numTriangles = 0;
		std::uint32_t firstOrdinal = 0;
		std::uint32_t headerIndex = 0;
		std::uint32_t collisionFlags = 0;
		std::uint32_t physicsMaterial = 0;
		std::uint32_t effectMaterial = 0;
		std::uint32_t userData = 0;
	};

	struct LeafInfo
	{
		std::uint32_t node = 0;
		C_AxisBoxMinMax box;
		std::uint32_t firstHeader = 0;
		std::uint32_t firstTriangle = 0;
		std::uint32_t triangleCount = 0;
		std::vector<GroupInfo> groups;
	};

	struct Mesh
	{
		std::uint32_t index = 0;
		OptimisedAABBTree tree;
		std::uint32_t combinedFlags = 0;
		std::uint32_t numHeaders = 0;
		std::vector<LeafInfo> leaves;
		std::vector<TriInfo> triangles;
		std::uint64_t treeBegin = 0, treeEnd = 0, instanceBegin = 0, instanceEnd = 0;
		F3 low, high;

		~Mesh() {}
	};

	struct Level
	{
		std::vector<Mesh*> meshes;
		std::uint64_t fileSize = 0;
		std::uint64_t mainOffset = 0, mainSize = 0;
		std::uint32_t streamVersion = 0, streamType = 0;
		std::uint64_t shapeStreamEnd = 0, constraintEnd = 0, pointerEnd = 0;

		~Level() { for (Mesh* m : meshes) delete m; }
	};

	static F3 decode_vertex(const Mesh& m, const LeafInfo& leaf, std::uint8_t index)
	{
		const OptimisedAABBNode& node = m.tree.m_pNodes[leaf.node];
		const Maths::HVec3 lv(&m.tree.m_pVertices[node.m_VerticeStartIndex + index]);
		const Maths::HVec3 range(leaf.box.m_max - leaf.box.m_min);
		return from_hvec(lv * range + leaf.box.m_min);
	}

	static F3 decode_normal(std::uint32_t packed)
	{
		MathsStorage::HenDN3 d;
		d.v = packed;
		return from_hvec(Maths::Load<Maths::HVec3, MathsStorage::HenDN3>(&d));
	}

	static bool load_level(const std::uint8_t* data, std::size_t size, Level& out, LoadError& err)
	{
		out.fileSize = size;
		if (size < 4 || std::memcmp(data, "  CP", 4) != 0)
		{
			fail(err, "bad_pc_marker", 0, "PC fourcc missing");
			return false;
		}
		Cursor root(data, size);
		std::uint8_t skip = 0;
		for (int i = 0; i < 4; ++i) if (!root.u8(skip, err)) return false;

		BlockInfo rootBlock;
		if (!read_block(root, rootBlock, err)) return false;
		if (std::strcmp(rootBlock.id, "Physic") != 0)
		{
			fail(err, "bad_root_block", rootBlock.offset, "root id is not Physic");
			return false;
		}

		std::uint64_t p = rootBlock.offset + 16;
		while (p < rootBlock.offset + rootBlock.size)
		{
			Cursor child(data, size);
			child.seek(p);
			BlockInfo b;
			if (!read_block(child, b, err)) return false;
			if (std::strcmp(b.id, "Main") == 0)
			{
				out.mainOffset = b.offset;
				out.mainSize = b.size;
				break;
			}
			p = b.offset + b.size;
		}
		if (out.mainSize == 0)
		{
			fail(err, "main_block_missing", 0, "no Main child in the root block");
			return false;
		}

		const std::uint64_t mainData = out.mainOffset + 16;
		const std::uint64_t mainEnd = out.mainOffset + out.mainSize;

		Sys::C_MemoryStream stream(const_cast<U8*>(data + mainData),
		                           static_cast<U32>(mainEnd - mainData));
		Sys::BinaryDeserialiser<Ut::NoEndianSwap> des(stream);

		char head[4] = {};
		if (!des.Read(head, 4) || std::memcmp(head, "Head", 4) != 0)
		{
			fail(err, "bad_head", mainData, "import stream does not start with Head");
			return false;
		}
		des >> out.streamVersion;
		if (out.streamVersion < 10)
		{
			fail(err, "unsupported_stream_version", mainData + 8, "tree v10 required");
			return false;
		}
		stream.SetVersionNumber(out.streamVersion);

		for (;;)
		{
			std::uint32_t type = 0;
			des >> type;
			const std::uint64_t typeOffset = mainData + stream.GetPosition() - 4;
			if (type == 0x0fffffffu)
			{
				out.shapeStreamEnd = typeOffset;
				break;
			}
			if (type != static_cast<std::uint32_t>(E_ImportTriangleMesh_Shape))
			{
				fail(err, "unsupported_shape_type", typeOffset, "non triangle-mesh shape record");
				return false;
			}
			if (out.meshes.empty())
				out.streamType = type;

			std::uint8_t basic[52];
			if (!des.Read(basic, 52))
			{
				fail(err, "read_basic", typeOffset + 4, "ImportBasic truncated");
				return false;
			}

			Mesh* mesh = new Mesh();
			mesh->index = static_cast<std::uint32_t>(out.meshes.size());
			mesh->treeBegin = mainData + stream.GetPosition();
			mesh->combinedFlags = mesh->tree.DeSerialise(des);
			mesh->treeEnd = mainData + stream.GetPosition();

			std::uint8_t instance[84];
			mesh->instanceBegin = mesh->treeEnd;
			if (!des.Read(instance, 84))
			{
				fail(err, "read_instance", mesh->treeEnd, "C_ShapeInstance truncated");
				delete mesh;
				return false;
			}
			mesh->instanceEnd = mainData + stream.GetPosition();

			if (mesh->tree.m_pVertices == NULL || mesh->tree.m_pNodes == NULL || mesh->tree.m_NumNodes == 0)
			{
				fail(err, "empty_tree", mesh->treeBegin, "tree has no nodes or vertices");
				delete mesh;
				return false;
			}
			mesh->tree.m_ExternallyOwned = false;
			mesh->low = from_hvec(mesh->tree.m_Low);
			mesh->high = from_hvec(mesh->tree.m_High);
			out.meshes.push_back(mesh);
		}

		std::uint32_t constraint = 0;
		des >> constraint;
		out.constraintEnd = mainData + stream.GetPosition() - 4;
		out.pointerEnd = mainData + stream.GetPosition();
		if (constraint != 0xffffffffu)
		{
			fail(err, "unsupported_constraint", out.constraintEnd, "constraint list is not empty");
			return false;
		}
		if (out.pointerEnd != mainEnd)
		{
			fail(err, "main_block_trailing", out.pointerEnd, "import stream does not end at the block boundary");
			return false;
		}

		// Load-order view of the engine's decoded tree: same traversal as
		// OptimisedAABBTree::DeSerialise, same header groups, same triangle
		// stream offsets. This reads engine data; it parses nothing twice.
		for (Mesh* mp : out.meshes)
		{
			Mesh& m = *mp;
			std::vector<std::uint32_t> stack;
			stack.push_back(0);
			std::uint32_t nextHeader = 0, nextTriangle = 0;
			while (!stack.empty())
			{
				const std::uint32_t nodeIndex = stack.back();
				stack.pop_back();
				if (nodeIndex >= m.tree.m_NumNodes)
				{
					fail(err, "node_index_out_of_range", m.treeBegin, "node index outside m_pNodes");
					return false;
				}
				OptimisedAABBNode& node = m.tree.m_pNodes[nodeIndex];
				if (node.m_TriangleSizeIndices == 0)
				{
					stack.push_back(nodeIndex + node.m_RightChildOffset);
					stack.push_back(nodeIndex + 1);
					continue;
				}

				LeafInfo leaf;
				leaf.node = nodeIndex;
				leaf.firstHeader = nextHeader;
				leaf.firstTriangle = nextTriangle;
				leaf.triangleCount = node.m_TriangleSizeIndices;
				node.m_BoundingBox.LoadBox(leaf.box, m.tree.m_Low, m.tree.m_High);

				std::uint32_t offset = 0, a = 0;
				while (a < node.m_TriangleSizeIndices)
				{
					C_TriangleHeader* header = m.tree.m_Triangles.GetHeader(node.m_TriangleStartIndex + offset);
					offset += sizeof(C_TriangleHeader);
					const std::uint32_t groupOffset = offset;
					GroupInfo g;
					g.offset = groupOffset;
					g.numTriangles = header->m_NumTriangles;
					g.firstOrdinal = a;
					g.headerIndex = nextHeader++;
					g.collisionFlags = header->m_CollisionFlags;
					g.physicsMaterial = header->m_PhysicsMaterialIndex;
					g.effectMaterial = header->m_EffectMaterialIndex;
					g.userData = header->m_UserDataFlags;
					leaf.groups.push_back(g);

					const std::uint32_t count =
						((a + header->m_NumTriangles) > node.m_TriangleSizeIndices)
						? (node.m_TriangleSizeIndices - a) : header->m_NumTriangles;
					for (std::uint32_t i = 0; i < count; ++i)
					{
						const AABBTreeTriangle* tri = m.tree.m_Triangles.GetTriangles(
							node.m_TriangleStartIndex + offset + sizeof(AABBTreeTriangle) * i);
						TriInfo t;
						t.a = tri->m_IndexA;
						t.b = tri->m_IndexB;
						t.c = tri->m_IndexC;
						t.normal = tri->m_SurfaceNormal.v;
						t.ordinal = a + i;
						m.triangles.push_back(t);
					}
					a += header->m_NumTriangles;
					offset += sizeof(AABBTreeTriangle) * header->m_NumTriangles;
				}
				nextTriangle += leaf.triangleCount;
				m.leaves.push_back(leaf);
			}
			m.numHeaders = nextHeader;

			// A harness lookup key must be unique. If the mesh does not satisfy
			// it, stop instead of picking one of several leaves.
			for (std::size_t i = 0; i < m.leaves.size(); ++i)
			{
				for (std::size_t j = i + 1; j < m.leaves.size(); ++j)
				{
					const std::uint32_t vi = m.tree.m_pNodes[m.leaves[i].node].m_VerticeStartIndex;
					const std::uint32_t vj = m.tree.m_pNodes[m.leaves[j].node].m_VerticeStartIndex;
					if (vi == vj)
					{
						fail(err, "ambiguous_leaf_vertex_start", m.leaves[j].node,
						     "two leaves share m_VerticeStartIndex; the callback cannot identify the leaf");
						return false;
					}
				}
			}
		}
		return true;
	}

	// ------------------------------------------------------------------ fixture

	struct RayQuery { F3 start, direction; float maxDistance; float maxCosAngle; };
	struct SphereQuery { F3 centre; float radius; };
	struct CacheQuery { F3 centre, extents, negativeNormal; float maxCosAngle; RayQuery trace; };

	struct QueryTable
	{
		std::vector<RayQuery> rays;
		std::vector<std::string> rayLabels;
		std::vector<SphereQuery> spheres;
		std::vector<std::string> sphereLabels;
		std::vector<CacheQuery> caches;
		std::vector<std::string> cacheLabels;
	};

	struct GlobalTri { std::uint32_t mesh = 0, leaf = 0, ordinal = 0, normal = 0; F3 a, b, c; };

	static bool global_triangle(const std::vector<Mesh*>& meshes, std::uint32_t ord, GlobalTri& out)
	{
		for (Mesh* const mp : meshes)
		{
			Mesh& m = *mp;
			if (ord >= m.triangles.size()) { ord -= static_cast<std::uint32_t>(m.triangles.size()); continue; }
			for (const LeafInfo& leaf : m.leaves)
			{
				if (ord < leaf.firstTriangle + leaf.triangleCount)
				{
					const TriInfo& t = m.triangles[ord];
					out.mesh = m.index;
					out.leaf = leaf.node; // node index, matching the probe's leafIndex
					out.ordinal = t.ordinal;
					out.normal = t.normal;
					out.a = decode_vertex(m, leaf, t.a);
					out.b = decode_vertex(m, leaf, t.b);
					out.c = decode_vertex(m, leaf, t.c);
					return true;
				}
			}
			// Should not happen: triangles are stored contiguously per leaf.
			return false;
		}
		return false;
	}

	static std::uint32_t total_triangles(const std::vector<Mesh*>& meshes)
	{
		std::uint32_t n = 0;
		for (const Mesh* m : meshes) n += static_cast<std::uint32_t>(m->triangles.size());
		return n;
	}

	static QueryTable build_table(const Level& level)
	{
		QueryTable t;
		F3 lo(1e30f, 1e30f, 1e30f), hi(-1e30f, -1e30f, -1e30f);
		for (Mesh* const mp : level.meshes)
		{
			Mesh& m = *mp;
			lo.x = m.low.x < lo.x ? m.low.x : lo.x;
			lo.y = m.low.y < lo.y ? m.low.y : lo.y;
			lo.z = m.low.z < lo.z ? m.low.z : lo.z;
			hi.x = m.high.x > hi.x ? m.high.x : hi.x;
			hi.y = m.high.y > hi.y ? m.high.y : hi.y;
			hi.z = m.high.z > hi.z ? m.high.z : hi.z;
		}
		const std::uint32_t total = total_triangles(level.meshes);
		const float wheelMaxCos = -0.25f;

		for (std::uint32_t i = 0; i < 12; ++i)
		{
			RayQuery q;
			t.rayLabels.push_back("ray-down-" + std::to_string(i));
			const std::uint32_t gx = i % 4u, gz = i / 4u;
			const float ux = (static_cast<float>(gx) + 0.5f) * 0.25f;
			const float uz = (static_cast<float>(gz) + 0.5f) / 3.0f;
			q.start = F3(lo.x + (hi.x - lo.x) * ux, hi.y + 2.0f + 2.0f, lo.z + (hi.z - lo.z) * uz);
			q.direction = F3(0.0f, -1.0f, 0.0f);
			q.maxDistance = (hi.y - lo.y) + 8.0f;
			q.maxCosAngle = wheelMaxCos;
			t.rays.push_back(q);
		}
		for (std::uint32_t i = 12; i < 24; ++i)
		{
			RayQuery q;
			t.rayLabels.push_back("ray-random-" + std::to_string(i));
			Rng rng(0xA5A50000u + i);
			const std::uint32_t ord = (total == 0) ? 0u : (rng.next() % total);
			GlobalTri tri;
			F3 cen = lerp_bounds(lo, hi, 0.5f, 0.5f, 0.5f);
			if (global_triangle(level.meshes, ord, tri))
				cen = centroid(tri.a, tri.b, tri.c);
			const float ox = rng.unit() * 2.0f - 1.0f;
			const float oy = rng.unit() * 2.0f - 1.0f;
			const float oz = rng.unit() * 2.0f - 1.0f;
			const F3 dir = normalized_or_up(F3(ox, oy, oz));
			q.start = add(cen, mul(dir, 40.0f));
			q.direction = mul(dir, -1.0f);
			q.maxDistance = 60.0f;
			q.maxCosAngle = 1.0f;
			t.rays.push_back(q);
		}

		for (std::uint32_t i = 0; i < 6; ++i)
		{
			SphereQuery q;
			t.sphereLabels.push_back("point-vertex-" + std::to_string(i));
			const std::uint32_t ord = (total == 0) ? 0u : (i * total) / 6u;
			GlobalTri tri;
			q.centre = global_triangle(level.meshes, ord, tri) ? tri.a : lerp_bounds(lo, hi, 0.5f, 0.5f, 0.5f);
			q.radius = 0.0f;
			t.spheres.push_back(q);
		}
		for (std::uint32_t i = 0; i < 10; ++i)
		{
			SphereQuery q;
			t.sphereLabels.push_back("sphere-near-" + std::to_string(i));
			Rng rng(0xBEEF0000u + i);
			const std::uint32_t ord = (total == 0) ? 0u : (rng.next() % total);
			const float radius = 0.25f + 2.0f * rng.unit();
			GlobalTri tri;
			if (global_triangle(level.meshes, ord, tri))
				q.centre = add(centroid(tri.a, tri.b, tri.c), mul(decode_normal(tri.normal), 0.5f * radius));
			else
				q.centre = lerp_bounds(lo, hi, 0.5f, 0.5f, 0.5f);
			q.radius = radius;
			t.spheres.push_back(q);
		}
		for (std::uint32_t i = 16; i < 24; ++i)
		{
			SphereQuery q;
			t.sphereLabels.push_back("sphere-empty-" + std::to_string(i));
			Rng rng(0xC0DE0000u + i);
			q.centre = lerp_bounds(lo, hi, rng.unit(), rng.unit(), rng.unit());
			q.radius = 0.5f + 3.0f * rng.unit();
			t.spheres.push_back(q);
		}

		for (std::uint32_t i = 0; i < 8; ++i)
		{
			CacheQuery q;
			t.cacheLabels.push_back("cache-" + std::to_string(i));
			if (i + 1 == 8)
			{
				q.centre = F3((lo.x + hi.x) * 0.5f, (lo.y + hi.y) * 0.5f, (lo.z + hi.z) * 0.5f);
				q.extents = F3((hi.x - lo.x) * 0.5f + 10.0f,
				               (hi.y - lo.y) * 0.5f + 10.0f,
				               (hi.z - lo.z) * 0.5f + 10.0f);
			}
			else
			{
				const std::uint32_t ord = (total == 0) ? 0u : (i * total) / 8u;
				GlobalTri tri;
				if (global_triangle(level.meshes, ord, tri))
				{
					q.centre = add(centroid(tri.a, tri.b, tri.c), mul(decode_normal(tri.normal), 1.0f));
					q.extents = F3(1.5f, 1.5f, 1.5f);
				}
				else
				{
					q.centre = lerp_bounds(lo, hi, 0.5f, 0.5f, 0.5f);
					q.extents = F3(1.5f, 1.5f, 1.5f);
				}
			}
			q.negativeNormal = F3(0.0f, -1.0f, 0.0f);
			q.maxCosAngle = wheelMaxCos;
			q.trace.start = F3(q.centre.x, q.centre.y + q.extents.y + 2.0f, q.centre.z);
			q.trace.direction = F3(0.0f, -1.0f, 0.0f);
			q.trace.maxDistance = 20.0f;
			q.trace.maxCosAngle = wheelMaxCos;
			t.caches.push_back(q);
		}
		return t;
	}

	// ----------------------------------------------------------- callback shims

	struct Capture
	{
		bool accepted = false;
		std::uint32_t leaf = 0xffffffffu, group = 0xffffffffu;
		std::uint32_t groupOffset = 0, numTris = 0;
		std::uint32_t triOrdinal = 0xffffffffu, headerIndex = 0xffffffffu, normalPacked = 0;
	};

	static Capture g_capture;
	static const Mesh* g_currentMesh = NULL;
	static bool g_captureFailed = false;
	static std::string g_failReason;
	static std::vector<std::uint32_t> g_sphereLeaf;
	static bool g_sphereFailed = false;

	static bool find_leaf(const Mesh& m, std::uint32_t vertexStart, std::uint32_t groupOffset,
	                      std::uint32_t& leafIndex, std::uint32_t& groupIndex)
	{
		for (std::uint32_t i = 0; i < m.tree.m_NumNodes; ++i)
		{
			OptimisedAABBNode& n = m.tree.m_pNodes[i];
			if (n.m_TriangleSizeIndices == 0 || n.m_VerticeStartIndex != vertexStart)
				continue;
			for (std::uint32_t li = 0; li < m.leaves.size(); ++li)
			{
				const LeafInfo& leaf = m.leaves[li];
				if (leaf.node != i) continue;
				for (std::uint32_t g = 0; g < leaf.groups.size(); ++g)
				{
					if (leaf.groups[g].offset == groupOffset)
					{
						leafIndex = li;
						groupIndex = g;
						return true;
					}
				}
			}
		}
		return false;
	}

	static bool CaptureRayTriangle(const MathsStorage::Fixed3_S16<14>* const verts,
	                               const MathsStorage::HenDN3* const normals,
	                               const AABBTreeTriangle* const tris,
	                               const U32 triangleStartIndex, const U32 numTris,
	                               const U32 collisionFlags, const U32 userData,
	                               const U16 physicsMaterial, const U16 effectMaterial,
	                               C_Ray& ray, const Maths::HVec3& low, const Maths::HVec3& high)
	{
		const bool hit = CollideRayTriangleMesh(verts, normals, tris, triangleStartIndex, numTris,
		                                        collisionFlags, userData, physicsMaterial, effectMaterial,
		                                        ray, low, high);
		if (hit)
		{
			const Mesh& m = *g_currentMesh;
			const U32 vertexStart = static_cast<U32>(verts - m.tree.m_pVertices);
			U32 leafIndex = 0xffffffffu, groupIndex = 0xffffffffu;
			if (!find_leaf(m, vertexStart, triangleStartIndex, leafIndex, groupIndex))
			{
				g_captureFailed = true;
				g_failReason = "ray_lookup";
				return hit;
			}
			const LeafInfo& leaf = m.leaves[leafIndex];
			const GroupInfo& g = leaf.groups[groupIndex];
			const U32 triIndex = (ray.m_result.m_TriangleIndex - triangleStartIndex) /
			                     static_cast<U32>(sizeof(AABBTreeTriangle));
			g_capture.accepted = true;
			g_capture.leaf = leafIndex;          // index into m.leaves
			g_capture.group = groupIndex;
			g_capture.groupOffset = triangleStartIndex;
			g_capture.numTris = numTris;
			g_capture.triOrdinal = g.firstOrdinal + triIndex;
			g_capture.headerIndex = g.headerIndex;
			g_capture.normalPacked = tris[triIndex].m_SurfaceNormal.v;
		}
		return hit;
	}

	struct SphereContactRec
	{
		std::uint32_t mesh = 0, triangleOrdinal = 0, engineHashValue = 0, patch = 0;
		std::uint32_t physicsMaterial = 0, effectMaterial = 0;
		F3 point, normal;
		float penetration = 0.0f;
	};

	// Encounter-ordered contacts: the probe appends contacts in traversal order,
	// while C_CollisionResult groups them by patch. A per-call before/after diff
	// recovers the append order without changing the engine's result.
	static std::vector<SphereContactRec> g_sphereContacts;

	static bool CaptureSphereTriangles(C_Shape* pShape,
	                                   const MathsStorage::Fixed3_S16<14>* const verts,
	                                   const MathsStorage::HenDN3* const normals,
	                                   const AABBTreeTriangle* const tris,
	                                   const U32 numTris, const U32 triangleStartIndex,
	                                   C_CollisionResult<6, 16>& res,
	                                   const U32 physicsMaterial, const U32 effectMaterial,
	                                   const U32 collisionFlags,
	                                   const Maths::HVec3& low, const Maths::HVec3& high)
	{
		const Mesh& m = *g_currentMesh;
		const U32 vertexStart = static_cast<U32>(verts - m.tree.m_pVertices);
		U32 leafIndex = 0xffffffffu, groupIndex = 0xffffffffu;
		if (!find_leaf(m, vertexStart, triangleStartIndex, leafIndex, groupIndex))
		{
			g_sphereFailed = true;
			g_failReason = "sphere_lookup";
			return false;
		}
		const LeafInfo& leaf = m.leaves[leafIndex];
		const GroupInfo& g = leaf.groups[groupIndex];

		// The engine's group call loops over triangles; call it once per
		// triangle so the appended contacts can be recorded in encounter
		// order. CollideSphereTriangleMesh is stateless between iterations
		// except for `res`, which is threaded through unchanged, so the
		// per-triangle sequence produces the same result as the group loop.
		bool any = false;
		for (U32 i = 0; i < numTris; ++i)
		{
			U32 before[6] = {};
			const U32 patchesBefore = res.m_NumContactPatches;
			for (U32 p = 0; p < patchesBefore && p < 6; ++p)
				before[p] = res.m_ContactPatches[p].m_NumContactPoints;

			const bool hit = CollideSphereTriangleMesh<6, 16>(pShape, verts, normals, tris + i,
			                                                 1, triangleStartIndex + i, res,
			                                                 physicsMaterial, effectMaterial,
			                                                 collisionFlags, low, high);
			any = any || hit;

			for (U32 p = 0; p < res.m_NumContactPatches && p < 6; ++p)
			{
				const C_ContactPatch<16>& patch = res.m_ContactPatches[p];
				const U32 first = (p < patchesBefore) ? before[p] : 0u;
				for (U32 c = first; c < patch.m_NumContactPoints; ++c)
				{
					const C_ContactPoint& pt = patch.m_ContactPoints[c];
					SphereContactRec r;
					r.mesh = m.index;
					r.engineHashValue = pt.m_HashValue;
					r.patch = p;
					r.physicsMaterial = pt.m_PhysicsMaterialIndices;
					r.effectMaterial = pt.m_EffectMaterialIndices;
					r.point = from_hvec(pt.m_ContactPoint);
					r.normal = from_hvec(patch.m_Normal.m_V);
					r.penetration = *reinterpret_cast<const float*>(&pt.m_PenetrationDepth);
					r.triangleOrdinal = g.firstOrdinal + i;
					g_sphereContacts.push_back(r);
				}
			}
		}
		return any;
	}

	// ------------------------------------------------------------- engine calls

	static void initialise_ray(C_Ray& ray, const RayQuery& q, const C_CollisionFilter& filter)
	{
		ray.InitialiseRay(to_hvec(q.start),
		                  Maths::C_Normal(to_hvec(q.direction), Maths::C_Normal::UNIT_LENGTH_VECTOR),
		                  q.maxDistance, &filter, 0.0f);
		ray.SetMaxCosAngle(q.maxCosAngle);
		ray.SetDoubleSided(false);
	}

	struct RayResult
	{
		bool hit = false;
		std::uint32_t mesh = 0xffffffffu, leaf = 0xffffffffu, triangleOrdinal = 0xffffffffu;
		std::uint32_t engineTriangleIndex = 0xffffffffu, header = 0xffffffffu;
		std::uint32_t collisionFlags = 0, physicsMaterial = 0, effectMaterial = 0, userData = 0;
		std::uint32_t normalPacked = 0;
		F3 contact, normal;
		float distance = 0.0f;
		std::uint32_t bodiesTested = 0;
	};

	static RayResult ray_trace_scene(const Level& level, const RayQuery& q, std::uint32_t& bodiesTested)
	{
		bodiesTested = 0;
		const C_CollisionFilter filter;
		for (Mesh* const mp : level.meshes)
		{
			Mesh& m = *mp;
			++bodiesTested;
			C_Ray ray;
			initialise_ray(ray, q, filter);
			SharedPhysics::C_SafeStack<true> stack(16000);
			SharedPhysics::C_SmallSPUCache spuCache(2);
			g_currentMesh = &m;
			g_capture = Capture();
			g_captureFailed = false;
			const bool hit = m.tree.RayTracing<CaptureRayTriangle>(ray, stack, spuCache);
			if (g_captureFailed)
				return RayResult();
			if (!hit)
				continue;

			RayResult r;
			r.hit = true;
			r.mesh = m.index;
			r.leaf = m.leaves[g_capture.leaf].node; // node index, as the probe reports
			r.triangleOrdinal = g_capture.triOrdinal;
			r.engineTriangleIndex = static_cast<std::uint32_t>(ray.m_result.m_TriangleIndex);
			r.header = g_capture.headerIndex;
			r.collisionFlags = ray.m_result.m_CollisionFlags;
			r.physicsMaterial = ray.m_result.m_PhysicsMaterialIndex;
			r.effectMaterial = ray.m_result.m_EffectMaterialIndex;
			r.userData = ray.m_result.m_UserData;
			r.normalPacked = g_capture.normalPacked;
			r.contact = from_hvec(ray.m_result.m_contact);
			r.normal = from_hvec(ray.m_result.m_normal);
			r.distance = ray.m_result.m_distance;
			r.bodiesTested = bodiesTested;
			return r;
		}
		RayResult miss;
		miss.bodiesTested = bodiesTested;
		return miss;
	}

	struct SphereResult
	{
		bool hit = false;
		std::uint32_t headersFiltered = 0;
		std::vector<SphereContactRec> contacts;
	};

	static SphereResult sphere_query_scene(const Level& level, const SphereQuery& q, bool& filterRefused)
	{
		SphereResult out;
		const C_CollisionFilter filter;
		for (Mesh* const mp : level.meshes)
		{
			Mesh& m = *mp;
			for (const LeafInfo& leaf : m.leaves)
				for (const GroupInfo& g : leaf.groups)
					if (!filter.CanCollide(g.collisionFlags))
					{
						filterRefused = true;
						g_failReason = "filter_refused_header";
					}

			C_SphereShape shape(&filter);
			shape.m_Sphere.Centre(to_hvec(q.centre));
			shape.m_Sphere.Radius(q.radius);

			C_CRAxisBox box;
			box.centre = to_hvec(q.centre);
			box.extents = Maths::HVec3(q.radius, q.radius, q.radius);

			C_CollisionObject obj;
			obj.m_pShape = &shape;
			obj.m_pSpuShape = &shape;
			obj.m_TransformedBox = box;
			obj.m_Index = 0;
			obj.m_Radius = q.radius;

			C_CollisionResult<6, 16> res;
			SharedPhysics::C_SafeStack<true> stack(16000);
			SharedPhysics::C_SmallSPUCache spuCache(2);
			g_currentMesh = &m;
			g_sphereContacts.clear();
			g_sphereFailed = false;
			const bool hit = m.tree.Collide<6, 16, CaptureSphereTriangles>(&obj, res, stack, spuCache);
			if (g_sphereFailed)
				filterRefused = true;
			out.hit = out.hit || hit;
			for (const SphereContactRec& c : g_sphereContacts)
				out.contacts.push_back(c);
		}
		return out;
	}

	struct CachedTriangle
	{
		std::uint32_t engineTriangleIndex = 0, triangleOrdinal = 0, leaf = 0;
		std::uint32_t collisionFlags = 0, physicsMaterial = 0, effectMaterial = 0, userData = 0;
		std::uint32_t normalPacked = 0;
		F3 a, b, c;
		F3 normal;
	};

	struct CacheRun
	{
		std::uint32_t cachedTriangles = 0, engineHigh = 0;
		std::uint32_t bodiesConsidered = 0, bodiesAccepted = 0;
		std::uint32_t headersFiltered = 0, trianglesTested = 0, trianglesRejectedByNormal = 0;
		bool derivedMatchesEngine = false;
		std::vector<CachedTriangle> entries;
		RayResult trace;
	};

	static bool resolve_leaf_triangle(const Mesh& m, std::uint32_t engineIndex,
	                                  std::uint32_t& leafIndex, std::uint32_t& ordinal)
	{
		std::uint32_t hits = 0;
		for (std::uint32_t i = 0; i < m.leaves.size(); ++i)
		{
			const LeafInfo& leaf = m.leaves[i];
			const std::uint32_t start = m.tree.m_pNodes[leaf.node].m_TriangleStartIndex;
			if (engineIndex < start) continue;
			const std::uint32_t o = engineIndex - start;
			if (o < leaf.triangleCount)
			{
				leafIndex = i;
				ordinal = o;
				++hits;
			}
		}
		return hits == 1;
	}

	static CacheRun run_cache(const Level& level, const CacheQuery& q)
	{
		CacheRun out;
		const C_CollisionFilter filter;

		C_CRAxisBox box;
		box.centre = to_hvec(q.centre);
		box.extents = to_hvec(q.extents);
		const Maths::C_Normal negativeNormal(to_hvec(q.negativeNormal), Maths::C_Normal::UNIT_LENGTH_VECTOR);

		SharedPhysics::C_SafeStack<true> stack(16000);
		SharedPhysics::C_SmallSPUCache spuCache(2);
		C_LineCollisionCache cache;
		cache.Reset();

		for (Mesh* const mp : level.meshes)
		{
			if (cache.Full()) break;
			Mesh& m = *mp;
			++out.bodiesConsidered;
			out.bodiesAccepted++;
			m.tree.FillLineCollisionCache(box, cache, stack, const_cast<C_CollisionFilter*>(&filter),
			                              NULL, NULL, negativeNormal, q.maxCosAngle, spuCache);
		}
		out.engineHigh = cache.m_High;
		out.cachedTriangles = cache.m_High;

		for (std::uint32_t k = 0; k < cache.m_High; ++k)
		{
			const C_CachedTriangle& t = cache.m_pTriangles[k];
			CachedTriangle e;
			e.engineTriangleIndex = t.m_TriangleIndex;
			e.collisionFlags = t.m_CollisionFlags;
			e.physicsMaterial = t.m_PhysicsMaterialFlags;
			e.effectMaterial = t.m_EffectMaterialFlags;
			e.userData = t.m_UserData;
			e.a = from_hvec(t.m_VertexA);
			e.b = from_hvec(t.m_VertexB);
			e.c = from_hvec(t.m_VertexC);
			e.normal = from_hvec(t.m_Normal.m_V);
			// Look up the owning mesh/leaf through the engine index, then
			// identify the exact triangle by matching the cached vertex bits.
			// Required because FillLineCollisionCache records the header
			// group's start ordinal (a), not the per-triangle ordinal.
			bool found = false;
			for (Mesh* const mp : level.meshes)
			{
				U32 li = 0, ord = 0;
				if (!resolve_leaf_triangle(*mp, e.engineTriangleIndex, li, ord))
					continue;
				const LeafInfo& leaf = mp->leaves[li];
				U32 matches = 0, actualOrdinal = 0;
				for (U32 i = 0; i < leaf.triangleCount; ++i)
				{
					const TriInfo& tri = mp->triangles[leaf.firstTriangle + i];
					const F3 va = decode_vertex(*mp, leaf, tri.a);
					const F3 vb = decode_vertex(*mp, leaf, tri.b);
					const F3 vc = decode_vertex(*mp, leaf, tri.c);
					if (pb(va.x) == pb(e.a.x) && pb(va.y) == pb(e.a.y) && pb(va.z) == pb(e.a.z) &&
					    pb(vb.x) == pb(e.b.x) && pb(vb.y) == pb(e.b.y) && pb(vb.z) == pb(e.b.z) &&
					    pb(vc.x) == pb(e.c.x) && pb(vc.y) == pb(e.c.y) && pb(vc.z) == pb(e.c.z))
					{
						++matches;
						actualOrdinal = i;
					}
				}
				if (matches != 1)
					break;
				e.leaf = leaf.node;
				e.triangleOrdinal = actualOrdinal;
				e.normalPacked = mp->triangles[leaf.firstTriangle + actualOrdinal].normal;
				found = true;
				break;
			}
			if (!found)
			{
				g_captureFailed = true;
				g_failReason = "cache_triangle_lookup";
				return out;
			}
			out.entries.push_back(e);
		}

		// Trace with the engine's own cache object.
		{
			C_Ray ray;
			initialise_ray(ray, q.trace, filter);
			const bool hit = cache.Trace(ray, NULL);
			out.trace.hit = hit;
			if (hit)
			{
				out.trace.contact = from_hvec(ray.m_result.m_contact);
				out.trace.normal = from_hvec(ray.m_result.m_normal);
				out.trace.distance = ray.m_result.m_distance;
				out.trace.engineTriangleIndex = static_cast<std::uint32_t>(ray.m_result.m_TriangleIndex);
				out.trace.collisionFlags = ray.m_result.m_CollisionFlags;
				out.trace.physicsMaterial = ray.m_result.m_PhysicsMaterialIndex;
				out.trace.effectMaterial = ray.m_result.m_EffectMaterialIndex;
				out.trace.userData = ray.m_result.m_UserData;
				for (const CachedTriangle& e : out.entries)
				{
					if (e.engineTriangleIndex == out.trace.engineTriangleIndex &&
					    pb(e.normal.x) == pb(out.trace.normal.x) &&
					    pb(e.normal.y) == pb(out.trace.normal.y) &&
					    pb(e.normal.z) == pb(out.trace.normal.z))
					{
						out.trace.leaf = e.leaf;
						out.trace.triangleOrdinal = e.triangleOrdinal;
						out.trace.normalPacked = e.normalPacked;
						break;
					}
				}
			}
		}

		out.bodiesConsidered = 0;
		out.bodiesAccepted = 0;

		// Derived counters, exactly the probe's scan (which is the model the
		// canonical record was defined with). The scan's cached set must equal
		// the engine's, otherwise the counters are not trustworthy.
		{
			std::vector<std::pair<std::uint32_t, std::uint32_t> > derived; // (leaf node, ordinal)
			enum { kCacheSize = 4 };
			auto full = [&derived]() { return derived.size() >= kCacheSize; };

			for (Mesh* const mp : level.meshes)
			{
				Mesh& m = *mp;
				if (full()) break;
				++out.bodiesConsidered;
				out.bodiesAccepted++;
				for (std::uint32_t li = 0; li < m.leaves.size(); ++li)
				{
					const LeafInfo& leaf = m.leaves[li];
					if (full()) break;
					if (!leaf.box.Intersects(box)) continue;
					for (const GroupInfo& g : leaf.groups)
					{
						if (!filter.CanCollide(g.collisionFlags))
						{
							++out.headersFiltered;
							continue;
						}
						for (std::uint32_t i = 0; i < g.numTriangles; ++i)
						{
							const TriInfo& tri = m.triangles[leaf.firstTriangle + g.firstOrdinal + i];
							const F3 v0 = decode_vertex(m, leaf, tri.a);
							const F3 v1 = decode_vertex(m, leaf, tri.b);
							const F3 v2 = decode_vertex(m, leaf, tri.c);
							C_AxisBoxMinMax tb;
							tb.m_min = Maths::HVec3(v0.x < v1.x ? (v0.x < v2.x ? v0.x : v2.x) : (v1.x < v2.x ? v1.x : v2.x),
							                        v0.y < v1.y ? (v0.y < v2.y ? v0.y : v2.y) : (v1.y < v2.y ? v1.y : v2.y),
							                        v0.z < v1.z ? (v0.z < v2.z ? v0.z : v2.z) : (v1.z < v2.z ? v1.z : v2.z));
							tb.m_max = Maths::HVec3(v0.x > v1.x ? (v0.x > v2.x ? v0.x : v2.x) : (v1.x > v2.x ? v1.x : v2.x),
							                        v0.y > v1.y ? (v0.y > v2.y ? v0.y : v2.y) : (v1.y > v2.y ? v1.y : v2.y),
							                        v0.z > v1.z ? (v0.z > v2.z ? v0.z : v2.z) : (v1.z > v2.z ? v1.z : v2.z));
							++out.trianglesTested;
							if (!tb.Intersects(box) ||
							    !HarnessIntersectAABBTriangle(box, to_hvec(v0), to_hvec(v1), to_hvec(v2)))
								continue;
							const F3 n = decode_normal(tri.normal);
							if (dot(n, q.negativeNormal) > q.maxCosAngle)
							{
								++out.trianglesRejectedByNormal;
								continue;
							}
							if (full())
								goto scan_done;
							derived.push_back(std::make_pair(leaf.node, tri.ordinal));
						}
					}
				}
			}
		scan_done:

			out.derivedMatchesEngine = (derived.size() == out.entries.size());
			if (out.derivedMatchesEngine)
			{
				for (std::size_t k = 0; k < derived.size(); ++k)
					if (derived[k].first != out.entries[k].leaf ||
					    derived[k].second != out.entries[k].triangleOrdinal)
						out.derivedMatchesEngine = false;
			}
			if (!out.derivedMatchesEngine)
			{
				g_captureFailed = true;
				char buf[160];
				std::size_t k = 0;
				std::snprintf(buf, sizeof(buf), "cache_derived_mismatch: first=%u derived=%u engine=%u derivedCount=%u engineCount=%u",
				              static_cast<unsigned>(k),
				              k < derived.size() ? derived[k].first : 0xffffffffu,
				              k < out.entries.size() ? out.entries[k].leaf : 0xffffffffu,
				              static_cast<unsigned>(derived.size()),
				              static_cast<unsigned>(out.entries.size()));
				g_failReason = buf;
			}
		}
		return out;
	}

	// ------------------------------------------------------------------ records

	static void append_ray_record(Bin& b, std::uint32_t index, const RayResult& r)
	{
		b.u8(1); b.u8(r.hit ? 1 : 0); b.u16(0);
		b.u32(index);
		b.u32(r.hit ? r.mesh : 0xffffffffu);
		b.u32(r.hit ? r.leaf : 0xffffffffu);
		b.u32(r.hit ? r.triangleOrdinal : 0xffffffffu);
		b.u32(r.hit ? r.engineTriangleIndex : 0xffffffffu);
		b.u32(r.hit ? r.header : 0xffffffffu);
		b.u32(r.hit ? r.collisionFlags : 0u);
		b.u32(r.hit ? r.physicsMaterial : 0u);
		b.u32(r.hit ? r.effectMaterial : 0u);
		b.u32(r.hit ? r.userData : 0u);
		b.u32(r.hit ? r.normalPacked : 0u);
		b.vec3(r.contact.x, r.contact.y, r.contact.z);
		b.vec3(r.normal.x, r.normal.y, r.normal.z);
		b.f32(r.hit ? r.distance : 0.0f);
		b.u32(r.bodiesTested);
	}

	static void append_sphere_record(Bin& b, std::uint32_t index, const SphereQuery& q, const SphereResult& r)
	{
		b.u8(2); b.u8(r.hit ? 1 : 0); b.u16(0);
		b.u32(index);
		b.f32(q.radius);
		b.vec3(q.centre.x, q.centre.y, q.centre.z);
		b.u32(r.headersFiltered);
		b.u32(static_cast<std::uint32_t>(r.contacts.size()));
		for (const SphereContactRec& c : r.contacts)
		{
			b.u32(c.mesh);
			b.u32(c.triangleOrdinal);
			b.u32(c.engineHashValue);
			b.u32(c.patch);
			b.u32(c.physicsMaterial);
			b.u32(c.effectMaterial);
			b.vec3(c.point.x, c.point.y, c.point.z);
			b.vec3(c.normal.x, c.normal.y, c.normal.z);
			b.f32(c.penetration);
		}
	}

	static void append_cache_record(Bin& b, std::uint32_t index, const CacheRun& f)
	{
		const RayResult& tr = f.trace;
		b.u8(3); b.u8(tr.hit ? 1 : 0); b.u16(0);
		b.u32(index);
		b.u32(f.cachedTriangles);
		b.u32(f.bodiesConsidered);
		b.u32(f.bodiesAccepted);
		b.u32(f.headersFiltered);
		b.u32(f.trianglesTested);
		b.u32(f.trianglesRejectedByNormal);
		for (const CachedTriangle& t : f.entries)
		{
			b.u32(t.engineTriangleIndex);
			b.u32(t.triangleOrdinal);
			b.u32(t.leaf);
			b.u32(t.collisionFlags);
			b.u32(t.physicsMaterial);
			b.u32(t.effectMaterial);
			b.u32(t.userData);
			b.u32(t.normalPacked);
			b.vec3(t.a.x, t.a.y, t.a.z);
			b.vec3(t.b.x, t.b.y, t.b.z);
			b.vec3(t.c.x, t.c.y, t.c.z);
		}
		b.u32(tr.hit ? tr.engineTriangleIndex : 0xffffffffu);
		b.u32(tr.hit ? tr.triangleOrdinal : 0xffffffffu);
		b.u32(tr.hit ? tr.leaf : 0xffffffffu);
		b.u32(tr.hit ? tr.collisionFlags : 0u);
		b.u32(tr.hit ? tr.physicsMaterial : 0u);
		b.u32(tr.hit ? tr.effectMaterial : 0u);
		b.u32(tr.hit ? tr.userData : 0u);
		b.u32(tr.hit ? tr.normalPacked : 0u);
		b.vec3(tr.contact.x, tr.contact.y, tr.contact.z);
		b.vec3(tr.normal.x, tr.normal.y, tr.normal.z);
		b.f32(tr.hit ? tr.distance : 0.0f);
	}

	// --------------------------------------------------------------------- run

	struct RunOptions
	{
		std::string label = "wasm-buffer";
		std::string target = "wasm32-emscripten";
		std::string flags;
	};

	static std::string error_json(const RunOptions& opt, const LoadError& err)
	{
		probe::Json j;
		j.begin_object();
		j.key("probe"); j.value_string("gravity-collision");
		j.key("status"); j.value_string("error");
		j.key("input"); j.begin_object(); j.key("label"); j.value_string(opt.label); j.end_object();
		j.key("error"); j.begin_object();
		j.key("code"); j.value_string(err.code);
		j.key("offset"); j.value_u64(err.offset);
		j.key("detail"); j.value_string(err.detail);
		j.end_object();
		j.end_object();
		return j.str();
	}

	static void emit_vec3(probe::Json& j, const F3& v)
	{
		j.begin_object();
		j.key("x"); j.value_bits(v.x);
		j.key("y"); j.value_bits(v.y);
		j.key("z"); j.value_bits(v.z);
		j.end_object();
	}

	static std::string run(const std::uint8_t* data, std::size_t size, const RunOptions& opt)
	{
		Level level;
		LoadError err;
		if (!load_level(data, size, level, err))
			return error_json(opt, err);

		g_captureFailed = false;
		g_failReason.clear();
		const QueryTable table = build_table(level);

		Bin canonical;
		probe::Json j;
		j.begin_object();
		j.key("probe"); j.value_string("gravity-collision");
		j.key("status"); j.value_string("ok");
		j.key("scope");
		j.begin_object();
		j.key("engineIntegration"); j.value_bool(true);
		j.key("vehiclePhysics"); j.value_bool(false);
		j.key("gameRun"); j.value_bool(false);
		j.key("codeSource"); j.value_string("upstream/BlurRebuilt Gravity narrowphase TUs, compiled for wasm32");
		j.key("meshImport"); j.value_string("OptimisedAABBTree::DeSerialise, gravity stream v10");
		j.key("rayRadius"); j.value_bits(0.0f);
		j.key("fatTrace"); j.value_string("unsupported");
		j.key("sphereQuery"); j.value_string("CollideSphereTriangleMesh<6,16>");
		j.key("normalisation"); j.value_string("engine HVec3 Normalise() on the web scalar path (exact IEEE 1/sqrt)");
		j.key("cacheCounters"); j.value_string("derived scan; must reproduce the engine cached set");
		j.key("instanceTransforms"); j.value_string("none (C_ShapeInstance is reported, not applied)");
		j.end_object();

		j.key("input"); j.begin_object();
		j.key("label"); j.value_string(opt.label);
		j.key("size"); j.value_u64(size);
		j.key("sha256"); j.value_string(probe::sha256_hex(data, size));
		j.end_object();

		j.key("file"); j.begin_object();
		j.key("mainOffset"); j.value_u64(level.mainOffset);
		j.key("mainSize"); j.value_u64(level.mainSize);
		j.key("shapeStreamEnd"); j.value_u64(level.shapeStreamEnd);
		j.key("constraintTerminatorOffset"); j.value_u64(level.constraintEnd);
		j.key("gravityStreamVersion"); j.value_u32(level.streamVersion);
		j.key("gravityStreamType"); j.value_u32(level.streamType);
		j.key("meshCount"); j.value_u32(static_cast<std::uint32_t>(level.meshes.size()));
		j.end_object();

		j.key("meshes"); j.begin_array();
		for (Mesh* const mp : level.meshes)
		{
			Mesh& m = *mp;
			j.begin_object();
			j.key("index"); j.value_u32(m.index);
			j.key("numVertices"); j.value_u32(m.tree.m_NumVertices);
			j.key("numNormals"); j.value_u32(m.tree.m_NumNormals);
			j.key("numTriangles"); j.value_u32(static_cast<std::uint32_t>(m.triangles.size()));
			j.key("numLeaves"); j.value_u32(static_cast<std::uint32_t>(m.leaves.size()));
			j.key("numNodes"); j.value_u32(m.tree.m_NumNodes);
			j.key("numHeaders"); j.value_u32(m.numHeaders);
			j.key("numActiveEdges"); j.value_u32(m.tree.m_NumActiveEdges);
			j.key("triangleBufferBytes"); j.value_u32(m.tree.m_NumTriangles);
			j.key("combinedCollisionFlags"); j.value_hex(m.combinedFlags);
			j.key("low"); emit_vec3(j, m.low);
			j.key("high"); emit_vec3(j, m.high);
			j.key("treeBegin"); j.value_u64(m.treeBegin);
			j.key("treeEnd"); j.value_u64(m.treeEnd);
			j.key("instanceBegin"); j.value_u64(m.instanceBegin);
			j.key("instanceEnd"); j.value_u64(m.instanceEnd);
			j.end_object();
		}
		j.end_array();

		// rays
		j.key("rays"); j.begin_array();
		for (std::uint32_t i = 0; i < table.rays.size(); ++i)
		{
			std::uint32_t bodiesTested = 0;
			const RayResult r = ray_trace_scene(level, table.rays[i], bodiesTested);
			Bin record;
			append_ray_record(record, i, r);
			canonical.data().insert(canonical.data().end(), record.data().begin(), record.data().end());
			j.begin_object();
			j.key("label"); j.value_string(table.rayLabels[i]);
			j.key("hit"); j.value_bool(r.hit);
			j.key("start"); emit_vec3(j, table.rays[i].start);
			j.key("direction"); emit_vec3(j, table.rays[i].direction);
			j.key("maxCosAngle"); j.value_bits(table.rays[i].maxCosAngle);
			j.key("maxDistance"); j.value_bits(table.rays[i].maxDistance);
			j.key("record"); j.value_string(probe::hex_bytes(record.data()));
			j.end_object();
		}
		j.end_array();

		// spheres
		bool filterRefused = false;
		j.key("spheres"); j.begin_array();
		for (std::uint32_t i = 0; i < table.spheres.size(); ++i)
		{
			const SphereResult r = sphere_query_scene(level, table.spheres[i], filterRefused);
			Bin record;
			append_sphere_record(record, i, table.spheres[i], r);
			canonical.data().insert(canonical.data().end(), record.data().begin(), record.data().end());
			j.begin_object();
			j.key("label"); j.value_string(table.sphereLabels[i]);
			j.key("hit"); j.value_bool(r.hit);
			j.key("centre"); emit_vec3(j, table.spheres[i].centre);
			j.key("radius"); j.value_bits(table.spheres[i].radius);
			j.key("contactCount"); j.value_u32(static_cast<std::uint32_t>(r.contacts.size()));
			j.key("record"); j.value_string(probe::hex_bytes(record.data()));
			j.end_object();
		}
		j.end_array();

		// cache fills
		j.key("cacheQueries"); j.begin_array();
		for (std::uint32_t i = 0; i < table.caches.size(); ++i)
		{
			const CacheRun r = run_cache(level, table.caches[i]);
			Bin record;
			append_cache_record(record, i, r);
			canonical.data().insert(canonical.data().end(), record.data().begin(), record.data().end());
			j.begin_object();
			j.key("label"); j.value_string(table.cacheLabels[i]);
			j.key("boxCentre"); emit_vec3(j, table.caches[i].centre);
			j.key("boxExtents"); emit_vec3(j, table.caches[i].extents);
			j.key("negativeNormal"); emit_vec3(j, table.caches[i].negativeNormal);
			j.key("maxCosAngle"); j.value_bits(table.caches[i].maxCosAngle);
			j.key("traceStart"); emit_vec3(j, table.caches[i].trace.start);
			j.key("traceDirection"); emit_vec3(j, table.caches[i].trace.direction);
			j.key("traceMaxDistance"); j.value_bits(table.caches[i].trace.maxDistance);
			j.key("cachedTriangles"); j.value_u32(r.cachedTriangles);
			j.key("engineCachedTriangles"); j.value_u32(r.engineHigh);
			j.key("derivedMatchesEngine"); j.value_bool(r.derivedMatchesEngine);

			j.key("trianglesTested"); j.value_u32(r.trianglesTested);
			j.key("trianglesRejectedByNormal"); j.value_u32(r.trianglesRejectedByNormal);
			j.key("traceHit"); j.value_bool(r.trace.hit);
			j.key("record"); j.value_string(probe::hex_bytes(record.data()));
			j.end_object();
		}
		j.end_array();

		if (g_captureFailed || filterRefused)
		{
			probe::Json e;
			e.begin_object();
			e.key("probe"); e.value_string("gravity-collision");
			e.key("status"); e.value_string("error");
			e.key("error"); e.begin_object();
			e.key("code"); e.value_string(filterRefused ? "filter_refused_header" : (g_failReason.empty() ? "callback_lookup_failed" : g_failReason));
			e.key("offset"); e.value_u64(0);
			e.key("detail"); e.value_string(
				filterRefused ? "the accept-all filter rejected a mesh header, which the probe's records assume cannot happen"
				              : "the engine-selected leaf/group could not be identified or the derived cache scan disagreed");
			e.end_object();
			e.end_object();
			return e.str();
		}

		j.key("hashes"); j.begin_object();
		j.key("queryHash"); j.value_string(probe::sha256_hex(canonical.data().empty() ? NULL : canonical.data().data(),
		                                                      canonical.data().size()));
		j.key("canonicalRecordBytes"); j.value_u32(static_cast<std::uint32_t>(canonical.data().size()));
		j.end_object();

		j.key("build"); j.begin_object();
		j.key("target"); j.value_string(opt.target);
		j.key("flags"); j.value_string(opt.flags);
		j.end_object();
		j.end_object();
		return j.str();
	}

} // namespace spike

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#define GRAVITY_EXPORT EMSCRIPTEN_KEEPALIVE
#else
#define GRAVITY_EXPORT
#endif

extern "C"
{
	GRAVITY_EXPORT char* gravity_run(const char* data, int size)
	{
		spike::RunOptions opt;
		opt.flags = "T-005d gravity overlay: -O2 -ffp-contract=off -fno-fast-math";
		const char* payload = (data != NULL && size > 0) ? data : NULL;
		const std::string json = spike::run(reinterpret_cast<const std::uint8_t*>(payload),
		                                    payload ? static_cast<std::size_t>(size) : 0u, opt);
		char* out = static_cast<char*>(std::malloc(json.size() + 1));
		if (out == NULL) return NULL;
		std::memcpy(out, json.data(), json.size());
		out[json.size()] = '\0';
		return out;
	}

	GRAVITY_EXPORT void gravity_free(char* p) { std::free(p); }

	GRAVITY_EXPORT const char* gravity_flags()
	{
		return "T-005d gravity overlay: -O2 -ffp-contract=off -fno-fast-math";
	}

	GRAVITY_EXPORT const char* gravity_selftest()
	{
		// SHA-256 known vector, and the fixture RNG's first draw, pin the two
		// pure helper implementations the record format depends on.
		if (probe::sha256_hex(reinterpret_cast<const std::uint8_t*>("abc"), 3) !=
		    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
			return "sha256(abc)";
		spike::Rng rng(0xA5A5000Cu);
		const std::uint32_t first = rng.next();
		if (first != 0xb134d91eu)
		{
			static char msg[64];
			std::snprintf(msg, sizeof(msg), "xorshift32 seed 0xA5A5000C: %08x", first);
			return msg;
		}
		return "PASS";
	}
}

