#include "level_physics.h"

#include <cstring>

namespace oracle
{
	namespace
	{
		constexpr std::uint32_t kShapeStreamTerminator = 0x0FFFFFFFu;
		constexpr std::uint32_t kConstraintTerminator = 0xFFFFFFFFu;
		constexpr std::uint32_t kImportTriangleMeshShape = 0;
		// sizeof(C_TriangleHeader) on x86/x64: U32,U32,U32,U16,U8 -> padded to 16.
		constexpr std::uint32_t kTriangleHeaderBytes = 16;
		// sizeof(AABBTreeTriangle): HenDN3,U32,U8x3 -> padded to 12.
		constexpr std::uint32_t kAabbTriangleBytes = 12;
		constexpr std::uint32_t kStackSlots = 512; // car.cpp:601-602
		constexpr std::uint64_t kMaxReasonSize = 128ull * 1024ull * 1024ull;

		class Cursor
		{
		public:
			Cursor(const std::uint8_t* data, std::uint64_t begin, std::uint64_t end)
				: m_data(data), m_pos(begin), m_begin(begin), m_end(end)
			{
			}

			std::uint64_t pos() const { return m_pos; }
			std::uint64_t begin() const { return m_begin; }
			std::uint64_t end() const { return m_end; }

			bool need(std::uint64_t bytes, LoadError& err, const char* code) const
			{
				if (m_pos + bytes > m_end)
				{
					err.offset = m_pos;
					err.code = code;
					err.detail = "needed " + std::to_string(bytes) + " bytes before block end " +
					             std::to_string(m_end);
					return false;
				}
				return true;
			}

			bool u8(std::uint8_t& v, LoadError& err)
			{
				if (!need(1, err, "read_u8")) return false;
				v = m_data[m_pos];
				++m_pos;
				return true;
			}

			bool u16(std::uint16_t& v, LoadError& err)
			{
				if (!need(2, err, "read_u16")) return false;
				std::memcpy(&v, m_data + m_pos, 2);
				m_pos += 2;
				return true;
			}

			bool s16(std::int16_t& v, LoadError& err)
			{
				if (!need(2, err, "read_s16")) return false;
				std::memcpy(&v, m_data + m_pos, 2);
				m_pos += 2;
				return true;
			}

			bool u32(std::uint32_t& v, LoadError& err)
			{
				if (!need(4, err, "read_u32")) return false;
				std::memcpy(&v, m_data + m_pos, 4);
				m_pos += 4;
				return true;
			}

			bool i32(std::int32_t& v, LoadError& err)
			{
				if (!need(4, err, "read_i32")) return false;
				std::memcpy(&v, m_data + m_pos, 4);
				m_pos += 4;
				return true;
			}

			bool f32(float& v, LoadError& err)
			{
				if (!need(4, err, "read_f32")) return false;
				std::memcpy(&v, m_data + m_pos, 4);
				m_pos += 4;
				return true;
			}

			bool vec3(Vec3& v, LoadError& err)
			{
				return f32(v.x, err) && f32(v.y, err) && f32(v.z, err);
			}

			bool skip(std::uint64_t bytes, LoadError& err, const char* code)
			{
				if (!need(bytes, err, code)) return false;
				m_pos += bytes;
				return true;
			}

			void seek(std::uint64_t to) { m_pos = to; }

		private:
			const std::uint8_t* m_data;
			std::uint64_t m_pos;
			std::uint64_t m_begin;
			std::uint64_t m_end;
		};

		bool fail(LoadError& err, std::uint64_t offset, const char* code, const std::string& detail)
		{
			err.offset = offset;
			err.code = code;
			err.detail = detail;
			return false;
		}

		bool read_block(Cursor& cur, BlockInfo& out, LoadError& err)
		{
			const std::uint64_t at = cur.pos();
			if (!cur.need(16, err, "block_header_truncated"))
				return false;
			char raw[9] = {};
			// Read the id through the cursor so the position advances once.
			for (int i = 0; i < 8; ++i)
			{
				std::uint8_t c = 0;
				if (!cur.u8(c, err)) return false;
				raw[i] = static_cast<char>(c);
			}
			std::uint32_t size = 0;
			std::uint16_t count = 0;
			std::uint8_t type = 0;
			std::uint8_t comp = 0;
			if (!cur.u32(size, err) || !cur.u16(count, err) || !cur.u8(type, err) || !cur.u8(comp, err))
				return false;

			const std::size_t len = strnlen(raw, 8);
			out.offset = at;
			out.id.assign(raw, len);
			out.size = size;
			out.count = count;
			out.type = static_cast<std::int8_t>(type);
			out.compression = static_cast<std::int8_t>(comp);

			if (len == 0)
				return fail(err, at, "block_id_empty", "8-byte block id has no characters");
			if (size < 16)
				return fail(err, at, "block_size_too_small",
				            "declared size " + std::to_string(size) + " < 16-byte header");
			if (at + size > cur.end())
				return fail(err, at, "block_overruns_parent",
				            "block '" + out.id + "' ends at " + std::to_string(at + size) +
				            " beyond limit " + std::to_string(cur.end()));
			return true;
		}

		bool read_basic(Cursor& cur, Mesh& mesh, LoadError& err)
		{
			// C_ShapeDesc::ImportBasic for stream version >= 7
			// (gravity/include/gravity/sdk/BodyHelper.h:149-160)
			if (!cur.f32(mesh.margin, err) ||
			    !cur.f32(mesh.epsilon, err) ||
			    !cur.u32(mesh.physicsMaterialIndex, err) ||
			    !cur.u32(mesh.effectMaterialIndex, err) ||
			    !cur.u32(mesh.collisionFlag, err) ||
			    !cur.u32(mesh.nodeFlag, err) ||
			    !cur.f32(mesh.mass, err) ||
			    !cur.u32(mesh.originalExportID, err) ||
			    !cur.vec3(mesh.renderOffset, err) ||
			    !cur.u32(mesh.remapped, err) ||
			    !cur.u32(mesh.userDataFlag, err))
				return false;
			return true;
		}

		bool read_tree(Cursor& cur, Mesh& mesh, std::uint32_t streamVersion, LoadError& err)
		{
			// OptimisedAABBTree::DeSerialise (narrowphase/OptimisedAABBTree.cpp:141-337)
			if (streamVersion < 10)
				return fail(err, cur.pos(), "unsupported_stream_version",
				            "OptimisedAABBTree v10 layout required, stream version " +
				            std::to_string(streamVersion));

			const std::uint64_t treeBegin = cur.pos();
			if (!cur.u32(mesh.numVertices, err) ||
			    !cur.u32(mesh.numNormals, err) ||
			    !cur.u32(mesh.triangleCapacityBytes, err) ||
			    !cur.u32(mesh.numNodes, err) ||
			    !cur.vec3(mesh.low, err) ||
			    !cur.vec3(mesh.high, err))
				return false;

			if (mesh.numNodes == 0)
				return fail(err, treeBegin, "empty_tree", "m_NumNodes == 0");
			if (mesh.numVertices > (cur.end() - cur.pos()) / 12)
				return fail(err, treeBegin, "vertex_count_overruns", "numVertices too large for block");
			if (mesh.numNormals > (cur.end() - cur.pos()) / 4)
				return fail(err, treeBegin, "normal_count_overruns", "numNormals too large for block");

			mesh.vertexStream.resize(mesh.numVertices);
			for (std::uint32_t i = 0; i < mesh.numVertices; ++i)
			{
				if (!cur.vec3(mesh.vertexStream[i], err))
					return false;
			}

			mesh.normals.resize(mesh.numNormals);
			for (std::uint32_t i = 0; i < mesh.numNormals; ++i)
			{
				if (!cur.u32(mesh.normals[i], err))
					return false;
			}

			if (mesh.numNodes > (cur.end() - cur.pos()) / 28)
				return fail(err, treeBegin, "node_count_overruns", "numNodes too large for block");

			std::vector<std::int16_t> quantised(static_cast<std::size_t>(mesh.numNodes) * 6, 0);
			mesh.nodes.resize(mesh.numNodes);
			for (std::uint32_t i = 0; i < mesh.numNodes; ++i)
			{
				NodeRecord& n = mesh.nodes[i];
				for (int k = 0; k < 6; ++k)
				{
					if (!cur.s16(quantised[static_cast<std::size_t>(i) * 6 + k], err)) return false;
				}
				if (!cur.u32(n.triangleSizeIndices, err) ||
				    !cur.u32(n.startOrRightOffset, err) ||
				    !cur.u32(n.vertexStart, err) ||
				    !cur.u32(n.numVertices, err))
					return false;
			}

			const Vec3 range = mesh.high - mesh.low;
			for (std::uint32_t i = 0; i < mesh.numNodes; ++i)
			{
				NodeRecord& n = mesh.nodes[i];
				const std::int16_t* q = &quantised[static_cast<std::size_t>(i) * 6];
				const Vec3 local_min(decode_fixed_s16_14(q[0]),
				                     decode_fixed_s16_14(q[1]),
				                     decode_fixed_s16_14(q[2]));
				const Vec3 local_max(decode_fixed_s16_14(q[3]),
				                     decode_fixed_s16_14(q[4]),
				                     decode_fixed_s16_14(q[5]));
				n.box.min = local_min * range + mesh.low;
				n.box.max = local_max * range + mesh.low;
			}

			// Quantise the stream vertices per leaf, in the same leaf order as
			// the engine's traversal (the engine writes m_pVertices[i] for the
			// leaf's [vertexStart, vertexStart+numVertices) range).
			mesh.vertexS16.assign(static_cast<std::size_t>(mesh.numVertices) * 3, 0);

			std::uint32_t stack[kStackSlots];
			std::uint32_t size = 1;
			stack[0] = 0;
			std::uint32_t bufferOffset = 0;
			std::uint32_t leafIndex = 0;

			while (size != 0)
			{
				--size;
				const std::uint32_t nodeIndex = stack[size];
				if (nodeIndex >= mesh.numNodes)
					return fail(err, cur.pos(), "node_index_out_of_range",
					            "node " + std::to_string(nodeIndex) + " >= " +
					            std::to_string(mesh.numNodes));
				NodeRecord& nd = mesh.nodes[nodeIndex];
				if (nd.triangleSizeIndices == 0)
				{
					if (size + 2 > kStackSlots)
						return fail(err, cur.pos(), "stack_overflow", "traversal stack exceeded 512 slots");
					const std::uint64_t rightIndex = static_cast<std::uint64_t>(nodeIndex) + nd.startOrRightOffset;
					const std::uint64_t leftIndex = static_cast<std::uint64_t>(nodeIndex) + 1ull;
					if (rightIndex >= mesh.numNodes || leftIndex >= mesh.numNodes)
						return fail(err, cur.pos(), "child_index_out_of_range",
						            "internal node " + std::to_string(nodeIndex) +
						            " points outside the node array");
					stack[size] = static_cast<std::uint32_t>(rightIndex);
					++size;
					stack[size] = static_cast<std::uint32_t>(leftIndex);
					++size;
					continue;
				}

				if (nd.vertexStart > mesh.numVertices || nd.numVertices > mesh.numVertices - nd.vertexStart)
					return fail(err, cur.pos(), "leaf_vertex_range",
					            "leaf " + std::to_string(nodeIndex) + " vertex range out of bounds");

				const Vec3 leafRange = nd.box.max - nd.box.min;
				const Vec3 recip(1.0f / leafRange.x, 1.0f / leafRange.y, 1.0f / leafRange.z);
				for (std::uint32_t i = nd.vertexStart; i < nd.vertexStart + nd.numVertices; ++i)
				{
					const Vec3 temp = mesh.vertexStream[i];
					const Vec3 local = (temp - nd.box.min) * recip;
					mesh.vertexS16[static_cast<std::size_t>(i) * 3 + 0] = encode_fixed_s16_14(local.x);
					mesh.vertexS16[static_cast<std::size_t>(i) * 3 + 1] = encode_fixed_s16_14(local.y);
					mesh.vertexS16[static_cast<std::size_t>(i) * 3 + 2] = encode_fixed_s16_14(local.z);
				}

				LeafRecord leaf;
				leaf.nodeIndex = nodeIndex;
				leaf.box = nd.box;
				leaf.triangleBufferStart = bufferOffset;
				nd.triangleBufferStart = bufferOffset;
				nd.firstTriangle = static_cast<std::uint32_t>(mesh.triangles.size());
				leaf.vertexStart = nd.vertexStart;
				leaf.numVertices = nd.numVertices;
				leaf.triangleSizeIndices = nd.triangleSizeIndices;
				leaf.firstTriangle = static_cast<std::uint32_t>(mesh.triangles.size());
				leaf.numTriangles = 0;
				leaf.triangleBufferLength = 0;
				nd.firstHeader = static_cast<std::uint32_t>(mesh.headers.size());

				HeaderRecord header;
				std::uint32_t headerIndex = 0;
				auto read_header = [&](HeaderRecord& h) -> bool
				{
					if (!cur.u32(h.collisionFlags, err) ||
					    !cur.u16(h.physicsMaterial, err) ||
					    !cur.u32(h.effectMaterial, err) ||
					    !cur.u32(h.userDataFlags, err) ||
					    !cur.u8(h.numTriangles, err))
						return false;
					if (h.numTriangles == 0)
						return fail(err, cur.pos() - 1, "zero_triangle_header",
						            "C_TriangleHeader::m_NumTriangles == 0 (asserted by the engine)");
					return true;
				};

				std::uint32_t headerBufferOffset = bufferOffset;
				bufferOffset += kTriangleHeaderBytes;
				if (!read_header(header))
					return false;
				header.leafIndex = leafIndex;
				header.firstTriangle = static_cast<std::uint32_t>(mesh.triangles.size());
				header.bufferOffsetInLeaf = headerBufferOffset;
				mesh.headers.push_back(header);
				std::uint32_t headerIndexInMesh = static_cast<std::uint32_t>(mesh.headers.size() - 1);
				std::uint32_t triangleArrayOffset = bufferOffset;

				for (std::uint32_t a = 0; a < nd.triangleSizeIndices; ++a)
				{
					if (headerIndex >= header.numTriangles)
					{
						headerBufferOffset = bufferOffset;
						bufferOffset += kTriangleHeaderBytes;
						HeaderRecord next;
						if (!read_header(next))
							return false;
						header = next;
						header.leafIndex = leafIndex;
						header.firstTriangle = static_cast<std::uint32_t>(mesh.triangles.size());
						header.bufferOffsetInLeaf = headerBufferOffset;
						mesh.headers.push_back(header);
						headerIndexInMesh = static_cast<std::uint32_t>(mesh.headers.size() - 1);
						triangleArrayOffset = bufferOffset;
						headerIndex = 0;
					}

					TriangleRecord tri;
					if (!cur.u8(tri.indexA, err) || !cur.u8(tri.indexB, err) || !cur.u8(tri.indexC, err) ||
					    !cur.u32(tri.normalPacked, err) || !cur.u32(tri.activeEdgeDataIndex, err))
						return false;
					tri.headerIndex = headerIndexInMesh;
					tri.leafIndex = leafIndex;
					tri.ordinalInLeaf = a;
					tri.bufferOffsetInLeaf = triangleArrayOffset + kAabbTriangleBytes * headerIndex;

					if (tri.indexA >= nd.numVertices || tri.indexB >= nd.numVertices ||
					    tri.indexC >= nd.numVertices)
						return fail(err, cur.pos() - 11, "triangle_index_out_of_leaf",
						            "leaf " + std::to_string(nodeIndex) + " triangle index >= " +
						            std::to_string(nd.numVertices));

					mesh.triangles.push_back(tri);
					bufferOffset += kAabbTriangleBytes;
					++headerIndex;
				}

				leaf.numTriangles = static_cast<std::uint32_t>(mesh.triangles.size()) - leaf.firstTriangle;
				leaf.triangleBufferLength = bufferOffset - leaf.triangleBufferStart;
				nd.triangleBufferLength = leaf.triangleBufferLength;
				nd.numStreamedTriangles = leaf.numTriangles;
				nd.numHeaders = static_cast<std::uint32_t>(mesh.headers.size()) - nd.firstHeader;
				mesh.leaves.push_back(leaf);
				++leafIndex;
			}

			if (bufferOffset > mesh.triangleCapacityBytes)
				return fail(err, cur.pos(), "triangle_capacity_exceeded",
				            "stream used " + std::to_string(bufferOffset) + " of " +
				            std::to_string(mesh.triangleCapacityBytes) + " capacity bytes");
			mesh.triangleBufferBytes = bufferOffset;

			std::uint32_t numActiveEdges = 0;
			if (!cur.u32(numActiveEdges, err))
				return false;
			if (numActiveEdges > (cur.end() - cur.pos()) / 12)
				return fail(err, cur.pos(), "active_edge_count_overruns",
				            "numActiveEdges too large for block");
			mesh.numActiveEdges = numActiveEdges;
			if (!cur.skip(static_cast<std::uint64_t>(numActiveEdges) * 12ull, err, "active_edge_normals"))
				return false;

			mesh.streamBegin = treeBegin;
			mesh.streamEnd = cur.pos();
			return true;
		}
	}

	bool Mesh::isIdentityInstance() const
	{
		static const float kIdentity[9] = {1.0f, 0.0f, 0.0f, 0.0f, 1.0f, 0.0f, 0.0f, 0.0f, 1.0f};
		if (instancePosition.x != 0.0f || instancePosition.y != 0.0f || instancePosition.z != 0.0f)
			return false;
		for (int i = 0; i < 9; ++i)
		{
			if (std::memcmp(&instanceRotation[i], &kIdentity[i], sizeof(float)) != 0)
				return false;
		}
		return true;
	}

	Vec3 Level::boundsMin() const
	{
		if (meshes.empty()) return Vec3();
		Vec3 v = meshes[0].low;
		for (const Mesh& m : meshes) v = vmin(v, m.low);
		return v;
	}

	Vec3 Level::boundsMax() const
	{
		if (meshes.empty()) return Vec3();
		Vec3 v = meshes[0].high;
		for (const Mesh& m : meshes) v = vmax(v, m.high);
		return v;
	}

	bool load_level(const std::uint8_t* data, std::size_t size, Level& out, LoadError& err)
	{
		err = LoadError();
		out = Level();
		out.fileSize = size;

		if (data == nullptr || size < 20)
			return fail(err, 0, "file_too_small", "input shorter than the 20-byte root block header");
		if (size > kMaxReasonSize)
			return fail(err, 0, "file_too_large", "input exceeds the 128 MiB probe bound");

		if (std::memcmp(data, "  CP", 4) != 0)
			return fail(err, 0, "bad_pc_marker",
			            "expected the little-endian PC fourcc '  CP' (system/include/system/misc/Platform.h:29)");
		out.marker.assign(reinterpret_cast<const char*>(data), 4);

		Cursor root(data, 4, size);
		if (!read_block(root, out.root, err))
			return false;
		if (out.root.id != "Physic")
			return fail(err, out.root.offset, "bad_root_block",
			            "root block id is '" + out.root.id + "', expected 'Physic'");
		const std::uint64_t rootEnd = out.root.offset + out.root.size;
		if (rootEnd != size)
			return fail(err, rootEnd, "root_size_mismatch",
			            "root block ends at " + std::to_string(rootEnd) + ", file is " +
			            std::to_string(size) + " bytes");

		Cursor children(data, out.root.offset + 16, rootEnd);
		bool haveHeader = false;
		bool haveMain = false;
		while (children.pos() < rootEnd)
		{
			BlockInfo blk;
			if (!read_block(children, blk, err))
				return false;
			if (blk.id == "Header")
			{
				if (haveHeader)
					return fail(err, blk.offset, "duplicate_header_block", "second 'Header' child block");
				haveHeader = true;
				out.headerBlock = blk;
				Cursor h(data, blk.offset + 16, blk.offset + blk.size);
				std::uint32_t version = 0;
				std::int32_t routes = 0;
				if (!h.u32(version, err) || !h.i32(routes, err))
					return false;
				if (routes < 0 || routes > 4096)
					return fail(err, blk.offset, "bad_route_count", "routeCount " + std::to_string(routes));
				if (h.pos() != blk.offset + blk.size)
					return fail(err, h.pos(), "header_block_trailing",
					            std::to_string(blk.offset + blk.size - h.pos()) + " unread bytes");
				out.physicsFileVersion = version;
				out.routeCount = routes;
				children.seek(blk.offset + blk.size);
			}
			else if (blk.id == "Main")
			{
				if (haveMain)
					return fail(err, blk.offset, "duplicate_main_block", "second 'Main' child block");
				haveMain = true;
				out.mainBlock = blk;
				children.seek(blk.offset + blk.size);
			}
			else if (blk.id == "Routes")
			{
				if (out.haveRoutes)
					return fail(err, blk.offset, "duplicate_routes_block", "second 'Routes' child block");
				out.haveRoutes = true;
				out.routesBlock = blk;
				out.routeBlocksSeen = blk.count;
				children.seek(blk.offset + blk.size);
			}
			else
			{
				return fail(err, blk.offset, "unknown_root_child",
				            "root child '" + blk.id + "' is not part of the proven layout");
			}
		}
		if (!haveHeader || !haveMain)
			return fail(err, rootEnd, "missing_required_block",
			            "root requires 'Header' and 'Main' children");

		Cursor cur(data, out.mainBlock.offset + 16, out.mainBlock.offset + out.mainBlock.size);
		char head[5] = {};
		for (int i = 0; i < 4; ++i)
		{
			std::uint8_t c = 0;
			if (!cur.u8(c, err)) return false;
			head[i] = static_cast<char>(c);
		}
		if (std::memcmp(head, "Head", 4) != 0)
			return fail(err, out.mainBlock.offset + 16, "missing_gravity_head",
			            "main import scene does not start with the 'Head' fourcc");
		if (!cur.u32(out.gravityStreamVersion, err))
			return false;

		std::uint32_t shapeIndex = 0;
		for (;;)
		{
			std::uint32_t type = 0;
			if (!cur.u32(type, err))
				return false;
			if (shapeIndex == 0)
				out.gravityStreamType = type;
			if (type == kShapeStreamTerminator)
			{
				out.shapeStreamEnd = cur.pos();
				break;
			}
			if (++shapeIndex > 64)
				return fail(err, cur.pos() - 4, "too_many_shapes", "more than 64 static shapes");
			if (type != kImportTriangleMeshShape)
				return fail(err, cur.pos() - 4, "unsupported_shape_type",
				            "E_ImportShapeType " + std::to_string(type) +
				            " is not E_ImportTriangleMesh_Shape; the probe stops here");

			Mesh mesh;
			mesh.index = static_cast<std::uint32_t>(out.meshes.size());
			const std::uint64_t shapeBegin = cur.pos();
			if (!read_basic(cur, mesh, err))
				return false;
			if (!read_tree(cur, mesh, out.gravityStreamVersion, err))
				return false;
			mesh.instanceBegin = cur.pos();
			if (!cur.vec3(mesh.instancePosition, err))
				return false;
			for (int i = 0; i < 9; ++i)
			{
				if (!cur.f32(mesh.instanceRotation[i], err)) return false;
			}
			for (int i = 0; i < 9; ++i)
			{
				if (!cur.f32(mesh.instanceInertia[i], err)) return false;
			}
			(void)shapeBegin;
			out.meshes.push_back(std::move(mesh));
		}

		std::uint32_t constraintType = 0;
		if (!cur.u32(constraintType, err))
			return false;
		out.constraintTerminatorOffset = cur.pos() - 4;
		if (constraintType != kConstraintTerminator)
			return fail(err, cur.pos() - 4, "unsupported_constraint",
			            "constraint stream starts with type " + std::to_string(constraintType) +
			            "; the probe only accepts an empty constraint list");

		if (cur.pos() != cur.end())
			return fail(err, cur.pos(), "main_block_trailing",
			            std::to_string(cur.end() - cur.pos()) + " unread bytes at the end of 'Main'");

		if (out.meshes.empty())
			return fail(err, out.mainBlock.offset, "no_static_meshes", "no importable static mesh");

		if (out.routeCount > 0 && !out.haveRoutes)
			return fail(err, rootEnd, "missing_routes_block", "routeCount > 0 but no 'Routes' block");

		return true;
	}
}
