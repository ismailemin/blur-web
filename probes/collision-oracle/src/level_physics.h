// Bounded reader for Level.levelphysics (PC "  CP" block stream + Gravity
// C_ImportScene "Head" stream). All offsets are absolute file offsets so an
// error always names the byte position.
#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

#include "oracle_math.h"

namespace oracle
{
	struct LoadError
	{
		std::uint64_t offset = 0;
		std::string code;
		std::string detail;
		bool ok() const { return code.empty(); }
	};

	struct BlockInfo
	{
		std::uint64_t offset = 0;
		std::string id;
		std::uint32_t size = 0;
		std::uint16_t count = 0;
		std::int8_t type = 0;
		std::int8_t compression = 0;
	};

	struct TriangleRecord
	{
		std::uint8_t indexA = 0;
		std::uint8_t indexB = 0;
		std::uint8_t indexC = 0;
		std::uint32_t normalPacked = 0;
		std::uint32_t activeEdgeDataIndex = 0;
		std::uint32_t headerIndex = 0;
		std::uint32_t leafIndex = 0;
		std::uint32_t ordinalInLeaf = 0;
		std::uint32_t bufferOffsetInLeaf = 0;
	};

	struct HeaderRecord
	{
		std::uint32_t collisionFlags = 0;
		std::uint16_t physicsMaterial = 0;
		std::uint32_t effectMaterial = 0;
		std::uint32_t userDataFlags = 0;
		std::uint8_t numTriangles = 0;
		std::uint32_t leafIndex = 0;
		std::uint32_t firstTriangle = 0;
		std::uint32_t bufferOffsetInLeaf = 0;
	};

	struct NodeRecord
	{
		AxisBoxMinMax box;
		std::uint32_t triangleSizeIndices = 0;
		std::uint32_t startOrRightOffset = 0; // union m_TriangleStartIndex / m_RightChildOffset
		std::uint32_t vertexStart = 0;
		std::uint32_t numVertices = 0;
		std::uint32_t triangleBufferStart = 0; // filled while streaming triangles
		std::uint32_t triangleBufferLength = 0;
		std::uint32_t firstTriangle = 0;
		std::uint32_t numStreamedTriangles = 0;
		std::uint32_t firstHeader = 0;
		std::uint32_t numHeaders = 0;
	};

	struct LeafRecord
	{
		std::uint32_t nodeIndex = 0;
		AxisBoxMinMax box;
		std::uint32_t triangleBufferStart = 0;
		std::uint32_t triangleBufferLength = 0;
		std::uint32_t vertexStart = 0;
		std::uint32_t numVertices = 0;
		std::uint32_t triangleSizeIndices = 0;
		std::uint32_t firstTriangle = 0;
		std::uint32_t numTriangles = 0;
	};

	struct Mesh
	{
		std::uint32_t index = 0;
		Vec3 low, high;
		std::uint32_t numVertices = 0;
		std::uint32_t numNormals = 0;
		std::uint32_t triangleCapacityBytes = 0;
		std::uint32_t numNodes = 0;
		std::uint32_t numActiveEdges = 0;
		std::uint32_t triangleBufferBytes = 0;

		// Stream (absolute, per-mesh quantisation inputs).
		std::vector<Vec3> vertexStream;
		std::vector<std::uint32_t> normals;

		// Quantised vertices, 3 x S16 per entry, same order as vertexStream.
		std::vector<std::int16_t> vertexS16;

		std::vector<NodeRecord> nodes;
		std::vector<LeafRecord> leaves;
		std::vector<HeaderRecord> headers;
		std::vector<TriangleRecord> triangles;

		// Shape descriptor, recorded for evidence only.
		float margin = 0.0f;
		float epsilon = 0.0f;
		std::uint32_t physicsMaterialIndex = 0;
		std::uint32_t effectMaterialIndex = 0;
		std::uint32_t collisionFlag = 0;
		std::uint32_t nodeFlag = 0;
		float mass = 0.0f;
		std::uint32_t originalExportID = 0;
		Vec3 renderOffset;
		std::uint32_t remapped = 0;
		std::uint32_t userDataFlag = 0;

		// C_ShapeInstance
		Vec3 instancePosition;
		float instanceRotation[9] = {};
		float instanceInertia[9] = {};

		std::uint64_t streamBegin = 0;
		std::uint64_t streamEnd = 0;
		std::uint64_t instanceBegin = 0;

		bool isIdentityInstance() const;
	};

	struct Level
	{
		std::uint64_t fileSize = 0;
		std::string marker;
		BlockInfo root;
		BlockInfo headerBlock;
		BlockInfo mainBlock;
		BlockInfo routesBlock;
		bool haveRoutes = false;
		std::uint32_t physicsFileVersion = 0;
		std::int32_t routeCount = 0;
		std::uint32_t gravityStreamVersion = 0;
		std::uint32_t gravityStreamType = 0;
		std::vector<Mesh> meshes;
		std::uint32_t routeBlocksSeen = 0;
		std::uint64_t shapeStreamEnd = 0;
		std::uint64_t constraintTerminatorOffset = 0;

		Vec3 boundsMin() const;
		Vec3 boundsMax() const;
	};

	// Parses in-memory bytes. Never reads outside [0,size); never trusts a
	// count without checking the remaining bytes.
	bool load_level(const std::uint8_t* data, std::size_t size, Level& out, LoadError& err);
}
