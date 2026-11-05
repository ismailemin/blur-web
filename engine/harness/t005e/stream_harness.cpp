// T-005e level-streaming harness (P22: engine-parsed level index).
//
// Mounts the installed level files through the engine file layer
// (Sys::C_WebFileSystem -> Sys::C_WebFile -> platform/file -> JS source) and,
// above it, the engine's overlay file system (LogicalFs::C_OverlayFs).
//
// Two things are proved here:
//
//  1. RenderingData::Target::Scene reads Level.levelrender with the engine's
//     own archive code: Sys::C_FileBlock walks the level's Render block,
//     Arch::BinaryInputArchive and Deserialise(Scene) walk the target Scene,
//     and ChunkInfo/StreamData come from the engine's archive.inl serialiser.
//     No GPU object is created: the two Scene-path deserialisers that would
//     need a device (VertexDeclaration, Texture) have data-only PLATFORM_WEB
//     branches, and every renderer entry point in the display facade aborts.
//
//  2. Every ChunkInfo record produced by the engine is used as the stream
//     range for RenderingData::Target::StreamManager::LoadChunk, and the bytes
//     are hashed with FNV-1a 64. There is no probe-supplied chunk table in the
//     run: verify_stream.py compares the engine table to the two committed
//     readers afterwards.
//
// Also exercised: StreamData::OpenStreamFile (buffer-hint rule) and
// StreamData::CacheChunk on one prerequisite-free chunk. ProcessLoadChunk is
// compiled (see the TUS list) but is not run: it deserialises streamed
// resource blocks, which need GPU buffers.
//
// CLI:
//   node stream_harness.js <levelrender> <levelstream> <levelphysics>

#include <stdio.h>
#include <string.h>
#include <math.h>

#include <algorithm>
#include <vector>

// The renderingdata internals expect the library's own prelude (FRIEND_SERIALISE,
// VIRTUAL_SERIALISATION_KEY_DECL, archive macros). It includes no DX11 header on
// a non-Windows target; Display.h and fx/fx.h come from the stub directory.
#include "stdafx.h"

#include <system/serialise/C_WebFile.h>
#include <system/serialise/PlatformFileWeb.h>
#include <system/serialise/FileSystemGlobals.h>
#include <system/serialise/C_FileBlock.h>
#include <system/serialise/C_MemoryStream.h>

#include <system/scheduler.h>

#include <system/debug/log/GlobalInterface.h>
#include <system/debug/log/DebugLog.h>
#include <system/debug/Variables.h>

#include <OverlayFs/OverlayFs.h>
#include <OverlayFs/OverlayLayer.h>

#include <renderingdata/target.h>
#include <renderingdata/streaming.h>
#include <renderingdata/archive.h>
#include <renderingdata/noninterface/archive.inl>

// P27: the resource deserialisers are defined in target/archive.cpp (not in a
// header), so the harness declares their stable non-template entry points here.
// The definitions use exactly these types and qualifications.
namespace WebSpike
{
void ParseLoadedResourceBlockArchive( ::Arch::BinaryInputArchive& ar,
	::RenderingData::Target::ResourceBlock& block );
void ParseResourceBlockLodArchive( ::Arch::BinaryInputArchive& ar,
	::RenderingData::Target::ResourceBlock::Resources& next, S32 lod );
}

// GameHelpers.cpp defines this (util/logicalfs/source/gamefs/GameHelpers.cpp:31)
// and C_OverlayFs::GetBestLayer reads it. GameHelpers.cpp needs
// Sys::C_FileSystem::Instance() and cannot link here; the harness supplies the
// same variable with the shipped default (false), which selects E_Type_Newer.
namespace LogicalFs
{
Debug::Bool g_masterDiscEmulation( "Util.LogicalFs.OverlayFs.MasterDiscEmulation",
	false, Debug::Persist() );
}

namespace
{

const Scheduler::Policy kStreamerPolicy[8] = { 0, 0, 7, 7, 7, 7, 7, 7 };
const uint32_t kGroupPool = 64;

int gChecks = 0;
int gFailures = 0;

void check( const char* name, bool pass )
{
	++gChecks;
	if ( !pass )
		++gFailures;
	printf( "webfile check %s pass=%d\n", name, pass ? 1 : 0 );
}

uint64_t fnv_begin() { return 0xcbf29ce484222325ull; }

void fnv_bytes( uint64_t& hash, const U8* data, size_t bytes )
{
	for ( size_t i = 0; i < bytes; ++i )
	{
		hash ^= data[ i ];
		hash *= 0x100000001b3ull;
	}
}

void fnv_u32( uint64_t& hash, U32 value )
{
	U8 buffer[4];
	buffer[0] = (U8)( value );
	buffer[1] = (U8)( value >> 8 );
	buffer[2] = (U8)( value >> 16 );
	buffer[3] = (U8)( value >> 24 );
	fnv_bytes( hash, buffer, sizeof( buffer ) );
}

void fnv_u64( uint64_t& hash, U64 value )
{
	U8 buffer[8];
	for ( int i = 0; i < 8; i++ )
		buffer[ i ] = (U8)( value >> ( 8 * i ) );
	fnv_bytes( hash, buffer, sizeof( buffer ) );
}

struct FileHash
{
	uint64_t bytes;
	uint64_t hash;
	uint32_t reads;
	bool ok;
};

// Whole file through Sys::I_File in bounded reads. This is the same shape as
// the streaming reads; it proves the file layer above the level mount.
FileHash hash_file( Sys::I_FileSystem& fs, const char* path, U32 bufferHint )
{
	FileHash out = { 0, fnv_begin(), 0, false };
	Sys::I_File* file = fs.Open( Sys::C_FilePath( path ), Sys::E_FileAccess_Read,
		Sys::C_OpenParams( bufferHint ) );
	if ( !file )
	{
		printf( "webfile error open %s\n", path );
		return out;
	}

	const uint64_t length = file->Length();
	std::vector<U8> buffer( 64 * 1024 );
	while ( out.bytes < length )
	{
		const U32 want = (U32)std::min<uint64_t>( (uint64_t)buffer.size(),
			length - out.bytes );
		if ( !file->Read( &buffer[ 0 ], want ) )
		{
			printf( "webfile error read %s at %llu\n", path,
				(unsigned long long)out.bytes );
			break;
		}
		fnv_bytes( out.hash, &buffer[ 0 ], want );
		out.bytes += want;
		++out.reads;
	}
	delete file;
	out.ok = ( out.bytes == length );
	printf( "webfile file %s bytes=%llu hash=0x%016llx reads=%u ok=%d\n",
		path, (unsigned long long)out.bytes, (unsigned long long)out.hash,
		out.reads, out.ok ? 1 : 0 );
	return out;
}

// The engine streamer, one chunk at a time. On web LoadChunk performs the read
// in the same context and queues the completion (see the PLATFORM_WEB branch in
// renderingdata/source/noninterface/target/streammanager.cpp); GetChunkData is
// then the only way to observe it, exactly as on PC.
bool stream_one_chunk( RenderingData::Target::StreamManager& manager, Sys::I_File* file,
	S32 index, U64 offset, U64 storedBytes, uint64_t* hashOut )
{
	if ( !manager.LoadChunk( index, file, offset, storedBytes ) )
		return false;

	S32 gotIndex = -1;
	bool loadFailed = true;
	RenderingData::Target::StreamManager::AutoChunkPointer data =
		manager.GetChunkData( gotIndex, loadFailed );

	if ( gotIndex != index || data == 0 || loadFailed )
		return false;

	if ( hashOut )
	{
		*hashOut = fnv_begin();
		fnv_bytes( *hashOut, &*data, (size_t)storedBytes );
	}
	return true;
}

const char* kRenderPath = "/levels/usa_la_river/Level.levelrender";
const char* kStreamPath = "/levels/usa_la_river/Level.levelstream";
const char* kPhysicsPath = "/levels/usa_la_river/Level.levelphysics";

// --- P27: CPU-side draw list ------------------------------------------------

struct ChunkRange
{
	S32 chunk;
	S32 item;
	S32 lod;
	U64 offset;
	U64 bytes;
};

// The engine's own ChunkInfo table is the only source of chunk ranges: the
// harness never receives a probe table. A (block, lod) pair must identify
// exactly one item, or the request is refused.
bool findChunkItem( const RenderingData::Target::StreamData& table, S32 block,
	S32 lod, ChunkRange* out )
{
	int found = 0;

	for ( int i = 0; i < table.GetNumChunks(); i++ )
	{
		const RenderingData::ChunkInfo& info = table.GetChunkInfo( i );

		for ( int k = 0; k < info.GetNumItems(); k++ )
		{
			const RenderingData::ChunkInfo::Item& item = info.GetItem( k );

			if ( item.block == block && item.lod == lod )
			{
				if ( found )
					return false;

				out->chunk = i;
				out->item = k;
				out->lod = lod;
				out->offset = info.GetOffset();
				out->bytes = info.GetCompressedSize();
				++found;
			}
		}
	}

	return found == 1;
}

// One engine chunk read: LoadChunk + GetChunkData, then a private copy so the
// chunk allocator can be released before the archive is walked.
bool loadChunkCopy( RenderingData::Target::StreamManager& manager, Sys::I_File* file,
	const ChunkRange& range, std::vector<U8>& out )
{
	if ( !manager.LoadChunk( range.chunk, file, range.offset, range.bytes ) )
		return false;

	S32 gotIndex = -1;
	bool loadFailed = true;
	RenderingData::Target::StreamManager::AutoChunkPointer data =
		manager.GetChunkData( gotIndex, loadFailed );

	if ( gotIndex != range.chunk || loadFailed || data == 0 )
		return false;

	out.assign( &*data, &*data + (size_t)range.bytes );
	return true;
}

struct DrawTotals
{
	int nodes;
	int primitives;
	int renderLists;
	int draws;
	int otherBlock;
	int unbound;
	int triangles;
	int triangleIndices;
	int vertices;
	int indexErrors;
	int instances;
	int basePrimitives;
	int instanceBlock27Draws;
	int instanceBlock27Triangles;
	int instanceBlock27Vertices;
	uint64_t hash;
};

struct GeometryView
{
	S32 block;
	bool valid;
	const WebSpike::BufferRecord* vertexBuffers;
	int vertexBufferCount;
	const WebSpike::BufferRecord* indexBuffers;
	int indexBufferCount;
};

// P32: the instance list's geometry is spread over several stream chunks (15,
// 17, 26, 27, 32). Each supplied block keeps its own buffer view into the same
// per-chunk record tables; a block that is deliberately not imported (31, whose
// chunk declares prerequisites) is listed with the reason to report, never
// silently treated as empty.
struct GeometrySet
{
	int count;
	GeometryView views[ 8 ];

	int unsupportedCount;
	struct
	{
		S32 block;
		const char* reason;
	} unsupported[ 8 ];
};

const GeometryView* findGeometry( const GeometrySet& set, S32 block )
{
	for ( int i = 0; i < set.count; i++ )
	{
		if ( set.views[ i ].block == block )
			return &set.views[ i ];
	}

	return 0;
}

const char* unsupportedGeometryReason( const GeometrySet& set, S32 block )
{
	for ( int i = 0; i < set.unsupportedCount; i++ )
	{
		if ( set.unsupported[ i ].block == block )
			return set.unsupported[ i ].reason;
	}

	return 0;
}

void fnv_f32( uint64_t& hash, F32 value )
{
	U32 bits;
	memcpy( &bits, &value, sizeof( bits ) );
	fnv_u32( hash, bits );
}

void fnv_string( uint64_t& hash, const char* text )
{
	const U32 bytes = (U32)strlen( text );
	fnv_u32( hash, bytes );
	fnv_bytes( hash, (const U8*)text, bytes );
}

// --- P30: constant material rows ------------------------------------------
//
// The target RenderListNode serialiser already reads the constant material
// table (m_constantMaterialData / m_constantMaterialTypes) through the
// engine's own DeserialiseMaterialData path. This resolver only reads values
// back: it follows MATERIAL_ELEMENT_TYPE_MATERIAL_INDEX children (serialised
// value type 8) exactly as the committed Python reference does, and it never
// writes a material or invents a blend value.
struct MaterialRefView
{
	int index;
	int list;
};

struct MaterialProbe
{
	bool worldFound;
	bool worldFinite;
	bool worldAffine;
	int worldRow;
	int worldAssignments;
	F32 world[ 16 ];

	bool albedoFound;
	bool albedoConflict;
	bool albedoDynamic;
	bool fieldTypeUnsupported;
	bool outOfRange;
	bool recursive;
	bool dynamicRef;
	bool albedoType8;

	int albedoRow;
	int albedoTexIndex;
	const char* albedoName;
	int albedoAssignments;
	int type8Elements;
};

void applyMaterialRef( const RenderingData::MaterialListData& data,
	const RenderingData::MaterialList& types, const MaterialRefView& ref,
	MaterialProbe* probe, int* stack, int stackSize )
{
	if ( probe->dynamicRef || probe->outOfRange || probe->recursive )
		return;

	if ( ref.list != 0 )
	{
		probe->dynamicRef = true;
		return;
	}

	if ( ref.index < 0 || ref.index >= data.GetNumMaterials() )
	{
		probe->outOfRange = true;
		return;
	}

	for ( int i = 0; i < stackSize; i++ )
	{
		if ( stack[ i ] == ref.index )
		{
			probe->recursive = true;
			return;
		}
	}

	if ( stackSize >= 32 )
	{
		probe->recursive = true;
		return;
	}

	stack[ stackSize ] = ref.index;

	const RenderingData::Material& material = data.GetMaterial( ref.index );
	const int typeIndex = material.GetTypeIndex();

	if ( typeIndex < 0 || typeIndex >= types.GetNumMaterialTypes() )
	{
		probe->outOfRange = true;
		return;
	}

	const RenderingData::MaterialType& type = types.GetMaterialType( typeIndex );

	for ( int e = 0; e < type.GetNumElements(); e++ )
	{
		const RenderingData::MaterialElement& element = type.GetElement( e );
		const int elementType = (int)element.type;
		const char* name = element.name.Chars();

		if ( elementType == RenderingData::MATERIAL_ELEMENT_TYPE_MATERIAL_INDEX )
		{
			probe->albedoType8 = true;

			for ( int c = 0; c < element.count; c++ )
			{
				S32 raw = 0;
				memcpy( &raw, material.GetData( type.GetOffset( e, c ) ),
					sizeof( raw ) );
				MaterialRefView child;
				child.index = raw & 0x0FFFFFFF;
				child.list = raw >> 28;
				++probe->type8Elements;
				applyMaterialRef( data, types, child, probe, stack, stackSize + 1 );
			}

			continue;
		}

		if ( strcmp( name, "g_mWorld" ) == 0 )
		{
			if ( elementType == (int)RenderingData::MATERIAL_ELEMENT_TYPE_F32 &&
				element.count == 16 )
			{
				F32 values[ 16 ];
				bool finite = true;

				for ( int k = 0; k < 16; k++ )
				{
					memcpy( &values[ k ],
						material.GetData( type.GetOffset( e, k ) ), sizeof( F32 ) );

					if ( !isfinite( values[ k ] ) )
						finite = false;
				}

				probe->worldFound = true;
				probe->worldRow = ref.index;
				probe->worldFinite = finite;
				probe->worldAffine = finite && values[ 3 ] == 0.0f &&
					values[ 7 ] == 0.0f && values[ 11 ] == 0.0f &&
					values[ 15 ] == 1.0f;
				memcpy( probe->world, values, sizeof( probe->world ) );
				++probe->worldAssignments;
			}
			else
			{
				probe->fieldTypeUnsupported = true;
			}
		}

		if ( strcmp( name, "g_tAlbedo" ) == 0 ||
			strcmp( name, "g_MeshTexture" ) == 0 )
		{
			if ( elementType == (int)RenderingData::MATERIAL_ELEMENT_TYPE_TEXTURE_INDEX &&
				element.count >= 1 )
			{
				S32 value = 0;
				memcpy( &value, material.GetData( type.GetOffset( e, 0 ) ),
					sizeof( value ) );

				if ( probe->albedoFound )
				{
					if ( probe->albedoRow != ref.index ||
						probe->albedoTexIndex != value ||
						strcmp( probe->albedoName, name ) != 0 )
						probe->albedoConflict = true;
				}
				else
				{
					probe->albedoFound = true;
					probe->albedoRow = ref.index;
					probe->albedoTexIndex = value;
					probe->albedoName = name;
				}

				++probe->albedoAssignments;
			}
			else if ( elementType ==
					(int)RenderingData::MATERIAL_ELEMENT_TYPE_DATA_INDEX ||
				elementType ==
					(int)RenderingData::MATERIAL_ELEMENT_TYPE_TEXTURE_PTR )
			{
				probe->albedoDynamic = true;
			}
			else
			{
				probe->fieldTypeUnsupported = true;
			}
		}
	}
}

void initMaterialProbe( MaterialProbe* probe )
{
	memset( probe, 0, sizeof( *probe ) );
	probe->worldRow = -1;
	probe->albedoRow = -1;
	probe->albedoTexIndex = -1;
}

void applyMaterial( const RenderingData::Target::RenderListNode& list,
	MaterialProbe* probe, int index, int listIndex )
{
	if ( index < 0 && listIndex == 0 )
		return;

	int stack[ 32 ];
	MaterialRefView ref;
	ref.index = index;
	ref.list = listIndex;

	applyMaterialRef( list.GetConstantMaterialListData(),
		list.GetConstantMaterialTypes(), ref, probe, stack, 0 );
}

const char* worldReason( const MaterialProbe& probe )
{
	if ( probe.dynamicRef ) return "runtimeMaterialTransform";
	if ( probe.outOfRange ) return "materialIndexOutOfBounds";
	if ( probe.recursive ) return "recursiveMaterialReference";
	if ( !probe.worldFound ) return "noConstantWorldMatrix";
	if ( !probe.worldFinite ) return "nonFiniteWorldMatrix";
	if ( !probe.worldAffine ) return "nonAffineWorldMatrix";
	return "none";
}

const char* albedoReason( const MaterialProbe& probe, char* id, int idBytes,
	int* row, int* index )
{
	*row = -1;
	*index = -1;
	id[ 0 ] = 0;

	if ( probe.albedoFound && !probe.albedoConflict )
	{
		snprintf( id, (size_t)idBytes, "%s:%d:%d", probe.albedoName,
			probe.albedoRow, probe.albedoTexIndex );
		*row = probe.albedoRow;
		*index = probe.albedoTexIndex;
		return "none";
	}

	if ( probe.albedoConflict ) return "multipleAlbedoParameters";
	if ( probe.albedoDynamic ) return "runtimeOnlyAlbedoParameter";
	if ( probe.fieldTypeUnsupported ) return "unsupportedAlbedoFieldType";
	if ( probe.outOfRange ) return "materialIndexOutOfBounds";
	if ( probe.recursive ) return "recursiveMaterialReference";
	if ( probe.dynamicRef ) return "runtimeMaterialList";
	return "noAlbedoParameter";
}

struct MaterialInventory
{
	int rows;
	int types;
	int worldRows;
	int albedoRows;
	int type8Rows;
	int runtimeRows;
	int externalRows;
};

void inventoryMaterials( const RenderingData::Target::RenderListNode& list,
	MaterialInventory* inventory )
{
	memset( inventory, 0, sizeof( *inventory ) );

	const RenderingData::MaterialListData& data =
		list.GetConstantMaterialListData();
	const RenderingData::MaterialList& types = list.GetConstantMaterialTypes();

	inventory->rows = data.GetNumMaterials();
	inventory->types = types.GetNumMaterialTypes();

	for ( int i = 0; i < inventory->rows; i++ )
	{
		const RenderingData::Material& material = data.GetMaterial( i );
		const int typeIndex = material.GetTypeIndex();

		if ( typeIndex < 0 || typeIndex >= inventory->types )
		{
			++inventory->externalRows;
			continue;
		}

		const RenderingData::MaterialType& type = types.GetMaterialType( typeIndex );
		bool world = false;
		bool albedo = false;
		bool type8 = false;
		bool runtime = false;

		for ( int e = 0; e < type.GetNumElements(); e++ )
		{
			const RenderingData::MaterialElement& element = type.GetElement( e );
			const int elementType = (int)element.type;
			const char* name = element.name.Chars();

			if ( elementType ==
				RenderingData::MATERIAL_ELEMENT_TYPE_MATERIAL_INDEX )
				type8 = true;

			if ( strcmp( name, "g_mWorld" ) == 0 &&
				elementType == (int)RenderingData::MATERIAL_ELEMENT_TYPE_F32 &&
				element.count == 16 )
				world = true;

			if ( strcmp( name, "g_tAlbedo" ) == 0 ||
				strcmp( name, "g_MeshTexture" ) == 0 )
			{
				if ( elementType ==
						(int)RenderingData::MATERIAL_ELEMENT_TYPE_TEXTURE_INDEX &&
					element.count >= 1 )
					albedo = true;
				else if ( elementType ==
						(int)RenderingData::MATERIAL_ELEMENT_TYPE_DATA_INDEX ||
					elementType ==
						(int)RenderingData::MATERIAL_ELEMENT_TYPE_TEXTURE_PTR )
					runtime = true;
			}
		}

		if ( world ) ++inventory->worldRows;
		if ( albedo ) ++inventory->albedoRows;
		if ( type8 ) ++inventory->type8Rows;
		if ( runtime ) ++inventory->runtimeRows;
	}
}

// --- P30: packet-v1.1-compatible draw records ----------------------------

struct PacketState
{
	int records;
	int drawable;
	int omitted;
	int directRecords;
	int directDrawable;
	int directOtherBlock;
	int directMaterials;
	int directMaterialNull;
	int directWorldNull;
	int instanceRecords;
	int instanceDrawable;
	int instanceOtherBlock;
	int instanceWorlds;
	int instanceWorldInvalid;
	int instanceMaterials;
	int instanceMaterialNull;
	int instanceSources;
	int materialRows;
	int materialTypes;
	int materialAlbedoRows;
	int materialWorldRows;
	int materialType8Rows;
	uint64_t hash;
};

struct PacketRecord
{
	int index;
	int kind; /* 0 direct primitive, 1 render-list instance */
	char mesh[ 96 ];
	S32 vbBlock;
	S32 vbIndex;
	S32 ibBlock;
	S32 ibIndex;
	int vertexOffset;
	int vertexCount;
	int indexOffset;
	int indexCount;
	bool worldValid;
	int worldRow;
	const char* worldReason;
	F32 world[ 16 ];
	char materialId[ 80 ];
	int materialRow;
	int albedoIndex;
	S32 albedoBlock;
	S32 albedoSourceIndex;
	const char* materialReason;
	const RenderingData::Bounds* bounds;
	const char* layer;
	int instanceIndex;
	int primitiveIndex;
	int sourceOffset;
	bool drawable;
	const char* reason;
};

void emitPacketRecord( PacketState* packet, const PacketRecord& record )
{
	printf( "webfiledraw packet %d kind=%s mesh=%s vb=%d:%d ib=%d:%d "
		"vtxOffset=%d vtxCount=%d idxOffset=%d idxCount=%d ",
		record.index, record.kind == 0 ? "direct" : "instance", record.mesh,
		(int)record.vbBlock, (int)record.vbIndex, (int)record.ibBlock,
		(int)record.ibIndex, record.vertexOffset, record.vertexCount,
		record.indexOffset, record.indexCount );

	if ( record.worldValid )
	{
		printf( "world=" );
		for ( int k = 0; k < 16; k++ )
			printf( "%s%.9g", k ? "," : "", record.world[ k ] );
		printf( " " );
	}
	else
	{
		printf( "world=null " );
	}

	printf( "worldRow=%d worldReason=%s materialId=%s materialRow=%d "
		"albedoIndex=%d albedo=%d:%d materialReason=%s layer=%s ",
		record.worldRow, record.worldValid ? "none" : record.worldReason,
		record.materialId[ 0 ] ? record.materialId : "null",
		record.materialRow, record.albedoIndex, (int)record.albedoBlock,
		(int)record.albedoSourceIndex, record.materialReason, record.layer );

	if ( record.bounds != 0 )
		printf( "bounds=ok boundsMin=%.9g,%.9g,%.9g boundsMax=%.9g,%.9g,%.9g ",
			record.bounds->aabbMin.x, record.bounds->aabbMin.y,
			record.bounds->aabbMin.z, record.bounds->aabbMax.x,
			record.bounds->aabbMax.y, record.bounds->aabbMax.z );
	else
		printf( "bounds=none boundsMin=0,0,0 boundsMax=0,0,0 " );

	printf( "instance=%d primitive=%d source=%d drawable=%d reason=%s\n",
		record.instanceIndex, record.primitiveIndex, record.sourceOffset,
		record.drawable ? 1 : 0, record.reason );

	fnv_u32( packet->hash, (U32)record.index );
	fnv_string( packet->hash, record.kind == 0 ? "direct" : "instance" );
	fnv_string( packet->hash, record.mesh );
	fnv_u32( packet->hash, (U32)record.vbBlock );
	fnv_u32( packet->hash, (U32)record.vbIndex );
	fnv_u32( packet->hash, (U32)record.ibBlock );
	fnv_u32( packet->hash, (U32)record.ibIndex );
	fnv_u32( packet->hash, (U32)record.vertexOffset );
	fnv_u32( packet->hash, (U32)record.vertexCount );
	fnv_u32( packet->hash, (U32)record.indexOffset );
	fnv_u32( packet->hash, (U32)record.indexCount );
	fnv_u32( packet->hash, record.worldValid ? 1u : 0u );
	if ( record.worldValid )
		for ( int k = 0; k < 16; k++ )
			fnv_f32( packet->hash, record.world[ k ] );
	fnv_u32( packet->hash, (U32)record.worldRow );
	fnv_string( packet->hash, record.worldValid ? "none" : record.worldReason );
	fnv_string( packet->hash, record.materialId[ 0 ] ? record.materialId : "null" );
	fnv_u32( packet->hash, (U32)record.materialRow );
	fnv_u32( packet->hash, (U32)record.albedoIndex );
	fnv_u32( packet->hash, (U32)record.albedoBlock );
	fnv_u32( packet->hash, (U32)record.albedoSourceIndex );
	fnv_string( packet->hash, record.materialReason );
	fnv_string( packet->hash, record.layer );
	fnv_u32( packet->hash, record.bounds != 0 ? 1u : 0u );
	if ( record.bounds != 0 )
	{
		fnv_f32( packet->hash, record.bounds->aabbMin.x );
		fnv_f32( packet->hash, record.bounds->aabbMin.y );
		fnv_f32( packet->hash, record.bounds->aabbMin.z );
		fnv_f32( packet->hash, record.bounds->aabbMax.x );
		fnv_f32( packet->hash, record.bounds->aabbMax.y );
		fnv_f32( packet->hash, record.bounds->aabbMax.z );
	}
	fnv_u32( packet->hash, record.drawable ? 1u : 0u );
	fnv_string( packet->hash, record.reason );
	fnv_u32( packet->hash, (U32)record.instanceIndex );
	fnv_u32( packet->hash, (U32)record.primitiveIndex );
	fnv_u32( packet->hash, (U32)record.sourceOffset );
}

void initPacketRecord( PacketRecord* record, int kind, int index )
{
	memset( record, 0, sizeof( *record ) );
	record->kind = kind;
	record->index = index;
	record->worldRow = -1;
	record->materialRow = -1;
	record->albedoIndex = -1;
	record->albedoBlock = -1;
	record->albedoSourceIndex = -1;
	record->instanceIndex = -1;
	record->primitiveIndex = -1;
	record->sourceOffset = -1;
	record->vertexOffset = -1;
	record->vertexCount = -1;
	record->indexOffset = -1;
	record->indexCount = -1;
	record->worldReason = "noConstantWorldMatrix";
	record->materialReason = "none";
	record->layer = "opaque";
	record->reason = "none";
}

void resolveAlbedo( const RenderingData::Target::RenderListNode& list,
	const MaterialProbe& probe, PacketRecord* record )
{
	char id[ 80 ];
	int row = -1;
	int index = -1;
	record->materialReason = albedoReason( probe, id, sizeof( id ), &row, &index );
	record->materialRow = row;
	record->albedoIndex = index;

	if ( row >= 0 && id[ 0 ] )
		strcpy( record->materialId, id );

	if ( index >= 0 && index < list.GetNumTextures() )
	{
		const RenderingData::ResourceIndex source = list.GetTextureSource( index );
		record->albedoBlock = source.GetBlock();
		record->albedoSourceIndex = source.GetIndex();
	}
}

// Parse every resource item of one chunk up to and including `range.item`.
// Returns the target item's Resources (owned by the caller) or 0.
RenderingData::Target::ResourceBlock::Resources* parseChunkItem(
	const std::vector<U8>& bytes, RenderingData::Target::Scene* scene,
	const ChunkRange& range, int* vbBase, int* ibBase, int* primitiveBase )
{
	Sys::C_MemoryStream stream( const_cast<U8*>( &bytes[ 0 ] ), (U32)bytes.size() );
	Arch::BinaryInputArchive ar( stream );

	S32 nItems = 0;
	ar >> nItems;

	// The chunk's own ChunkInfo record declares how many items it holds; the
	// archive read must agree.
	const RenderingData::ChunkInfo& info =
		scene->GetStreamData().GetChunkInfo( range.chunk );

	if ( nItems != info.GetNumItems() )
		return 0;

	RenderingData::Target::ResourceBlock::Resources* target = 0;

	for ( int i = 0; i < nItems; i++ )
	{
		const S32 lod = info.GetItem( i ).lod;
		const int vb0 = WebSpike::Draws().vertexBuffers;
		const int ib0 = WebSpike::Draws().indexBuffers;
		const int prim0 = WebSpike::Draws().primitives;

		RenderingData::Target::ResourceBlock::Resources* resources =
			new RenderingData::Target::ResourceBlock::Resources();
		resources->pScene = scene;

		WebSpike::ParseResourceBlockLodArchive( ar, *resources, lod );

		if ( i == range.item )
		{
			target = resources;
			if ( vbBase ) *vbBase = vb0;
			if ( ibBase ) *ibBase = ib0;
			if ( primitiveBase ) *primitiveBase = prim0;
			break;
		}

		delete resources;
	}

	return target;
}

// P32: parse one geometry chunk once, up to and including maxItem, recording
// each item's own buffer slice. The engine archive is sequential, so a later
// item can only be reached through the earlier ones; parsing the chunk once is
// what keeps the five supplied blocks inside the bounded arena (parsing the
// same chunk again per block would retain its preceding items twice).
struct ItemBuffers
{
	S32 block;
	int vertexBase;
	int vertexCount;
	int indexBase;
	int indexCount;
};

bool parseChunkUpToItem( const std::vector<U8>& bytes,
	RenderingData::Target::Scene* scene, const ChunkRange& range, int maxItem,
	ItemBuffers* items, int* itemCount )
{
	Sys::C_MemoryStream stream( const_cast<U8*>( &bytes[ 0 ] ), (U32)bytes.size() );
	Arch::BinaryInputArchive ar( stream );

	S32 nItems = 0;
	ar >> nItems;

	const RenderingData::ChunkInfo& info =
		scene->GetStreamData().GetChunkInfo( range.chunk );

	if ( nItems != info.GetNumItems() || maxItem < 0 || maxItem >= nItems )
		return false;

	*itemCount = 0;

	for ( int i = 0; i <= maxItem; i++ )
	{
		const S32 lod = info.GetItem( i ).lod;
		const int vb0 = WebSpike::Draws().vertexBuffers;
		const int ib0 = WebSpike::Draws().indexBuffers;

		RenderingData::Target::ResourceBlock::Resources* resources =
			new RenderingData::Target::ResourceBlock::Resources();
		resources->pScene = scene;

		WebSpike::ParseResourceBlockLodArchive( ar, *resources, lod );

		items[ *itemCount ].block = info.GetItem( i ).block;
		items[ *itemCount ].vertexBase = vb0;
		items[ *itemCount ].vertexCount =
			WebSpike::Draws().vertexBuffers - vb0;
		items[ *itemCount ].indexBase = ib0;
		items[ *itemCount ].indexCount =
			WebSpike::Draws().indexBuffers - ib0;
		++*itemCount;

		// Only the item's descriptors and payload bytes are kept; its node
		// tree is not walked for a geometry-only chunk.
		delete resources;
	}

	return true;
}

// Emit one draw record. Every field comes from the archive; a field that the
// engine did not bind is printed as null with a reason token, never guessed.
void emitOneDraw( const RenderingData::Target::RenderListNode& list, int drawIndex,
	int nodeIndex, const WebSpike::PrimitiveRecord& record, int primitiveIndex,
	S32 chunkIndex, const GeometryView& geometry, const RenderingData::Bounds* pBounds,
	unsigned char* usedVertexBuffer, DrawTotals* totals, PacketState* packet )
{
	const WebSpike::DrawListState& draws = WebSpike::Draws();

	int positionStream = -1;
	const char* reason = 0;

	if ( record.declaration < 0 || record.declaration >= draws.declarations )
	{
		reason = "declarationOutOfRange";
	}
	else
	{
		const WebSpike::DeclRecord& decl = draws.decl[ record.declaration ];
		int found = 0;

		for ( int e = 0; e < decl.count; e++ )
		{
			if ( decl.elements[ e ].usage == 0 && decl.elements[ e ].usageIndex == 0 )
			{
				if ( found )
					reason = "duplicatePosition0";

				positionStream = decl.elements[ e ].stream;
				++found;
			}
		}

		if ( found == 0 )
			reason = "noPosition0";
	}

	int vertexSource = -1;

	if ( reason == 0 )
	{
		int found = 0;

		for ( int s = 0; s < record.streamCount; s++ )
		{
			if ( record.streams[ s ].streamIndex == -1 )
				continue;

			if ( record.streams[ s ].streamIndex == positionStream )
			{
				if ( found )
					reason = "duplicatePositionStream";

				vertexSource = record.streams[ s ].vertexBuffer;
				++found;
			}
		}

		if ( found == 0 )
			reason = "positionStreamNotBound";
	}

	S32 vbBlock = -1;
	S32 vbIndex = -1;
	S32 ibBlock = -1;
	S32 ibIndex = -1;

	if ( reason == 0 )
	{
		if ( record.indexBuffer < 0 ||
			record.indexBuffer >= list.GetNumIndexBuffers() )
		{
			reason = "indexSourceOutOfRange";
		}
		else
		{
			const RenderingData::ResourceIndex index =
				list.GetIndexBufferSource( record.indexBuffer );
			ibBlock = index.GetBlock();
			ibIndex = index.GetIndex();
		}
	}

	if ( reason == 0 )
	{
		if ( vertexSource < 0 || vertexSource >= list.GetNumVertexBuffers() )
		{
			reason = "vertexSourceOutOfRange";
		}
		else
		{
			const RenderingData::ResourceIndex index =
				list.GetVertexBufferSource( vertexSource );
			vbBlock = index.GetBlock();
			vbIndex = index.GetIndex();
		}
	}

	bool bound = false;

	if ( reason == 0 )
	{
		if ( vbBlock != geometry.block || ibBlock != geometry.block )
		{
			++totals->otherBlock;
			reason = "geometryBlockNotImported";
		}
		else if ( !geometry.valid )
			reason = "geometryResourcesMissing";
		else if ( vbIndex < 0 || vbIndex >= geometry.vertexBufferCount )
			reason = "vertexBufferNotImported";
		else if ( ibIndex < 0 || ibIndex >= geometry.indexBufferCount )
			reason = "indexBufferNotImported";
		else if ( record.lodCount == 0 )
			reason = "primitiveHasNoLod";
		else
			bound = true;
	}

	int vertexShift = 0;
	int triangleCount = 0;
	int indexCount = 0;
	int firstIndex = totals->triangleIndices;
	const WebSpike::LodRecord* lod =
		record.lodCount > 0 ? &record.lods[ 0 ] : 0;

	if ( bound )
	{
		const WebSpike::BufferRecord& vb = geometry.vertexBuffers[ vbIndex ];
		const WebSpike::BufferRecord& ib = geometry.indexBuffers[ ibIndex ];
		int streamByteOffset = 0;

		for ( int s = 0; s < record.streamCount; s++ )
		{
			if ( record.streams[ s ].streamIndex == positionStream )
				streamByteOffset = record.streams[ s ].vertexOffset;
		}

		if ( vb.compression != 0 || ib.compression != 0 )
			reason = "compressedBuffer";
		else if ( !ib.payloadRetained )
			reason = "indexPayloadNotRetained";
		else if ( vb.stride <= 0 || ib.stride <= 0 )
			reason = "zeroBufferStride";
		else if ( lod->offset < 0 || lod->indices < 0 || lod->offset > ib.count ||
			lod->indices > ib.count - lod->offset )
			reason = "indexRangeOutOfBuffer";
		else if ( lod->minIndex < 0 || lod->vertices < 0 ||
			lod->minIndex > vb.count || lod->vertices > vb.count - lod->minIndex )
			reason = "vertexRangeOutOfBuffer";
		else if ( streamByteOffset < 0 || streamByteOffset % vb.stride != 0 )
			reason = "unalignedVertexStreamOffset";
		else
			vertexShift = streamByteOffset / vb.stride;

		if ( reason == 0 && vertexShift > vb.count )
			reason = "vertexShiftOutOfBuffer";

		if ( reason == 0 && record.topology != 0 && record.topology != 1 )
			reason = "unsupportedTopology";

		if ( reason == 0 && record.topology == 0 && ( lod->indices % 3 ) != 0 )
			reason = "triangleListIndexCount";

		if ( reason == 0 )
		{
			const U8* base = (const U8*)draws.arena + ib.payloadOffset;

			for ( int j = 0; j < lod->indices; j++ )
			{
				U32 value;
				if ( ib.stride == 2 )
					value = (U32)( (const U16*)base )[ lod->offset + j ];
				else
					value = ( (const U32*)base )[ lod->offset + j ];

				if ( value < (U32)lod->minIndex ||
					value >= (U32)( lod->minIndex + lod->vertices ) ||
					value >= (U32)( vb.count - vertexShift ) )
				{
					reason = "indexOutsidePrimitiveRange";
					break;
				}
			}
		}

		if ( reason == 0 )
		{
			const U8* base = (const U8*)draws.arena + ib.payloadOffset;

			if ( record.topology == 0 )
			{
				for ( int j = 0; j + 2 < lod->indices; j += 3 )
				{
					U32 a = ( (const U32*)base )[ 0 ]; // placeholder, replaced below
					(void)a;
					U32 i0, i1, i2;

					if ( ib.stride == 2 )
					{
						i0 = (U32)( (const U16*)base )[ lod->offset + j ];
						i1 = (U32)( (const U16*)base )[ lod->offset + j + 1 ];
						i2 = (U32)( (const U16*)base )[ lod->offset + j + 2 ];
					}
					else
					{
						i0 = ( (const U32*)base )[ lod->offset + j ];
						i1 = ( (const U32*)base )[ lod->offset + j + 1 ];
						i2 = ( (const U32*)base )[ lod->offset + j + 2 ];
					}

					if ( i0 == i1 || i1 == i2 || i0 == i2 )
						continue;

					++triangleCount;
				}
			}
			else
			{
				for ( int j = 2; j < lod->indices; j++ )
				{
					U32 i0, i1, i2;

					if ( ib.stride == 2 )
					{
						i0 = (U32)( (const U16*)base )[ lod->offset + j - 2 ];
						i1 = (U32)( (const U16*)base )[ lod->offset + j - 1 ];
						i2 = (U32)( (const U16*)base )[ lod->offset + j ];
					}
					else
					{
						i0 = ( (const U32*)base )[ lod->offset + j - 2 ];
						i1 = ( (const U32*)base )[ lod->offset + j - 1 ];
						i2 = ( (const U32*)base )[ lod->offset + j ];
					}

					if ( j % 2 )
					{
						const U32 swap = i0;
						i0 = i1;
						i1 = swap;
					}

					if ( i0 == i1 || i1 == i2 || i0 == i2 )
						continue;

					++triangleCount;
				}
			}

			indexCount = triangleCount * 3;
		}

		if ( reason != 0 )
		{
			bound = false;
			indexCount = 0;
			firstIndex = totals->triangleIndices;
		}
	}

	if ( bound )
	{
		++totals->draws;
		totals->triangles += triangleCount;
		totals->triangleIndices += indexCount;

		if ( vbIndex >= 0 && vbIndex < WebSpike::kMaxBuffers )
			usedVertexBuffer[ vbIndex ] = 1;
	}

	printf( "webfiledraw draw %d chunk=%d nodeIndex=%d primitive=%d source=%d "
		"bound=%d reason=%s declaration=%d topology=%d lod=0 lodCount=%d "
		"effect=%d vb=%d:%d ib=%d:%d "
		"vbSource=%d ibSource=%d "
		"firstIndex=%d indexCount=%d triangles=%d lodOffset=%d lodIndices=%d "
		"minIndex=%d nVertices=%d baseMaterial=%d:%d instanceMaterial=%d:%d "
		"flags=0x%08x blend=%d,%d,%d,%d,%d,%d,%d blendEnable=%d ",
		drawIndex, (int)chunkIndex, nodeIndex, primitiveIndex, record.streamOffset,
		bound ? 1 : 0, reason ? reason : "none", record.declaration,
		record.topology, record.lodCount, record.effect, (int)vbBlock,
		(int)vbIndex, (int)ibBlock,
		(int)ibIndex, vertexSource, record.indexBuffer,
		firstIndex, indexCount, triangleCount,
		lod ? lod->offset : -1, lod ? lod->indices : -1, lod ? lod->minIndex : -1,
		lod ? lod->vertices : -1, record.baseMaterialIndex, record.baseMaterialList,
		record.instanceMaterialIndex, record.instanceMaterialList,
		(unsigned)record.flags, record.blendSrc, record.blendDest, record.blendOp,
		record.alphaRef, record.alphaToMask, record.alphaTest, record.blendEnable,
		record.cullMode );

	if ( pBounds != 0 )
		printf( "bounds=ok boundsMin=%.9g,%.9g,%.9g boundsMax=%.9g,%.9g,%.9g ",
			pBounds->aabbMin.x, pBounds->aabbMin.y, pBounds->aabbMin.z,
			pBounds->aabbMax.x, pBounds->aabbMax.y, pBounds->aabbMax.z );
	else
		printf( "bounds=none " );

	printf( "world=null worldReason=instanceTransformNotImported\n" );

	// Deterministic draw-list hash over the printed numeric fields.
	fnv_u32( totals->hash, (U32)drawIndex );
	fnv_u32( totals->hash, (U32)primitiveIndex );
	fnv_u32( totals->hash, (U32)record.streamOffset );
	fnv_u32( totals->hash, bound ? 1u : 0u );
	fnv_u32( totals->hash, (U32)record.declaration );
	fnv_u32( totals->hash, (U32)record.topology );
	fnv_u32( totals->hash, (U32)record.effect );
	fnv_u32( totals->hash, (U32)vbBlock );
	fnv_u32( totals->hash, (U32)vbIndex );
	fnv_u32( totals->hash, (U32)ibBlock );
	fnv_u32( totals->hash, (U32)ibIndex );
	fnv_u32( totals->hash, (U32)firstIndex );
	fnv_u32( totals->hash, (U32)indexCount );
	fnv_u32( totals->hash, (U32)triangleCount );
	fnv_u32( totals->hash, (U32)( lod ? lod->offset : -1 ) );
	fnv_u32( totals->hash, (U32)( lod ? lod->indices : -1 ) );
	fnv_u32( totals->hash, (U32)( lod ? lod->minIndex : -1 ) );
	fnv_u32( totals->hash, (U32)( lod ? lod->vertices : -1 ) );
	fnv_u32( totals->hash, (U32)record.baseMaterialIndex );
	fnv_u32( totals->hash, (U32)record.baseMaterialList );
	fnv_u32( totals->hash, (U32)record.instanceMaterialIndex );
	fnv_u32( totals->hash, (U32)record.instanceMaterialList );
	fnv_u32( totals->hash, (U32)record.flags );

	// P30 packet record for this direct primitive. The material table is read
	// from the render list's constant rows; a transform is never applied to a
	// direct primitive (there is no instance placement), so world stays null
	// with an explicit reason.
	PacketRecord packetRecord;
	initPacketRecord( &packetRecord, 0, packet->records );
	packetRecord.vbBlock = vbBlock;
	packetRecord.vbIndex = vbIndex;
	packetRecord.ibBlock = ibBlock;
	packetRecord.ibIndex = ibIndex;
	packetRecord.vertexOffset = lod ? lod->minIndex + vertexShift : -1;
	packetRecord.vertexCount = lod ? lod->vertices : -1;
	packetRecord.indexOffset = lod ? lod->offset : -1;
	packetRecord.indexCount = lod ? lod->indices : -1;
	packetRecord.worldValid = false;
	packetRecord.worldReason = "noInstanceTransform";
	packetRecord.bounds = pBounds;
	packetRecord.layer = record.blendEnable ? "alpha" : "opaque";
	packetRecord.primitiveIndex = primitiveIndex;
	packetRecord.sourceOffset = record.streamOffset;
	packetRecord.drawable = bound;
	packetRecord.reason = bound ? "none" : ( reason ? reason : "unbound" );
	snprintf( packetRecord.mesh, sizeof( packetRecord.mesh ),
		"river.b%d.vb%d.b%d.ib%d", (int)vbBlock, (int)vbIndex, (int)ibBlock,
		(int)ibIndex );

	MaterialProbe probe;
	initMaterialProbe( &probe );
	applyMaterial( list, &probe, record.baseMaterialIndex,
		record.baseMaterialList );
	applyMaterial( list, &probe, record.instanceMaterialIndex,
		record.instanceMaterialList );

	for ( int s = 0; s < record.streamCount; s++ )
	{
		if ( record.streams[ s ].streamIndex == -1 )
			continue;
		applyMaterial( list, &probe, record.streams[ s ].materialIndex,
			record.streams[ s ].materialList );
	}

	resolveAlbedo( list, probe, &packetRecord );

	++packet->records;
	++packet->directRecords;
	if ( bound )
	{
		++packet->directDrawable;
		++packet->drawable;
	}
	else
	{
		++packet->omitted;
		if ( reason && strcmp( reason, "geometryBlockNotImported" ) == 0 )
			++packet->directOtherBlock;
	}
	if ( packetRecord.materialId[ 0 ] ) ++packet->directMaterials;
	else ++packet->directMaterialNull;
	++packet->directWorldNull;

	emitPacketRecord( packet, packetRecord );
}

// Walk every node of the parsed block, emit render-list draws and instances,
// and fill the deterministic totals.
void emitNodeDraws( RenderingData::Target::ResourceBlock::Resources* resources,
	const ChunkRange& range, const GeometryView& geometry, DrawTotals* totals,
	PacketState* packet )
{
	(void)range;

	const WebSpike::DrawListState& draws = WebSpike::Draws();
	unsigned char usedVertexBuffer[ WebSpike::kMaxBuffers ];

	for ( int i = 0; i < WebSpike::kMaxBuffers; i++ )
		usedVertexBuffer[ i ] = 0;

	int primitiveCursor = 0;
	int drawIndex = 0;

	for ( int n = 0; n < resources->nodes.Size(); n++ )
	{
		RenderingData::Node* node = Pointer( resources->nodes[ n ] );

		if ( node == 0 )
			continue;

		++totals->nodes;

		// Target::RenderListNode::GetPointer lives in the renderer TU
		// (render.cpp), which this build does not compile. IsNode is a virtual
		// that the target override defines inline, so the cast below is the
		// same test GetPointer performs.
		if ( !node->IsNode( RenderingData::NODE_TYPE_RENDER_LIST_PLATFORM ) )
		{
			printf( "webfiledraw node %d type=%d renderlist=0\n", n,
				(int)node->GetNodeType() );
			continue;
		}

		RenderingData::Target::RenderListNode* list =
			static_cast<RenderingData::Target::RenderListNode*>( node );

		const int numPrimitives = list->GetNumPrimitives();
		const int numInstances = list->GetNumInstances();
		const int numBasePrimitives = list->GetNumBasePrimitives();

		++totals->renderLists;
		totals->primitives += numPrimitives;
		totals->instances += numInstances;
		totals->basePrimitives += numBasePrimitives;

		printf( "webfiledraw list node=%d primitives=%d instances=%d "
			"baseprimitives=%d instancebatches=%d dynamiclists=%d\n", n,
			numPrimitives, numInstances, numBasePrimitives,
			list->GetNumInstanceBatches(), list->GetNumDynamicMaterialLists() );

		MaterialInventory inventory;
		inventoryMaterials( *list, &inventory );
		packet->materialRows += inventory.rows;
		packet->materialTypes += inventory.types;
		packet->materialAlbedoRows += inventory.albedoRows;
		packet->materialWorldRows += inventory.worldRows;
		packet->materialType8Rows += inventory.type8Rows;
		printf( "webfiledraw material node=%d chunk=%d types=%d rows=%d "
			"worldRows=%d albedoRows=%d type8Rows=%d runtimeRows=%d externalRows=%d\n",
			n, (int)range.chunk, inventory.types, inventory.rows,
			inventory.worldRows, inventory.albedoRows, inventory.type8Rows,
			inventory.runtimeRows, inventory.externalRows );

		for ( int i = 0; i < numPrimitives; i++ )
		{
			const int recordIndex = primitiveCursor + i;

			if ( recordIndex >= draws.primitives )
			{
				++totals->unbound;
				printf( "webfiledraw draw %d chunk=%d nodeIndex=%d primitive=%d "
					"source=-1 bound=0 reason=primitiveRecordMissing "
					"declaration=-1 topology=-1 effect=-1 vb=-1:-1 ib=-1:-1 "
					"firstIndex=0 indexCount=0 triangles=0 lodOffset=-1 "
					"lodIndices=-1 minIndex=-1 nVertices=-1 baseMaterial=-1:-1 "
					"instanceMaterial=-1:-1 flags=0x00000000 "
					"blend=-1,-1,-1,-1,-1,-1,-1 bounds=none world=null "
					"worldReason=instanceTransformNotImported\n",
					drawIndex, (int)range.chunk, n, i );
				++drawIndex;
				continue;
			}

			const RenderingData::Bounds* pBounds = 0;

			if ( i < list->GetNumPrimitives() )
			{
				// GetPrimitiveBounds indexes the archived per-primitive bounds
				// vector; a short vector is reported by leaving bounds null.
				if ( list->GetPrimitiveBounds() != 0 )
					pBounds = &list->GetPrimitiveBounds( i );
			}

			emitOneDraw( *list, drawIndex, n, draws.primitive[ recordIndex ], i,
				range.chunk, geometry, pBounds, usedVertexBuffer, totals, packet );
			++drawIndex;
		}

		// Archive order: primitives, instances, instance batches, base
		// primitives. Only primitives and base primitives produce records.
		primitiveCursor += numPrimitives + numBasePrimitives;
	}

	// The reference counts one entry per used source vertex buffer, in buffer
	// order. That is exactly the declaration-driven selection the reference
	// reader performs; no position data is decoded here.
	int vertices = 0;

	for ( int i = 0; i < geometry.vertexBufferCount; i++ )
	{
		if ( usedVertexBuffer[ i ] )
			vertices += geometry.vertexBuffers[ i ].count;
	}

	totals->vertices = vertices;
}

// --- P30: instance draws with the constant affine g_mWorld ------------------

struct StreamBinding
{
	int vertexBuffer;
	int vertexOffset;
	int frequency;
	int materialIndex;
	int materialList;
};

struct InstanceBinding
{
	bool valid;
	const char* reason;
	int vertexSource;
	int indexSource;
	S32 vbBlock;
	S32 vbIndex;
	S32 ibBlock;
	S32 ibIndex;
	int vertexShift;
	const WebSpike::BufferRecord* vb;
	const WebSpike::BufferRecord* ib;
	const WebSpike::LodRecord* lod;
};

void bindInstanceGeometry( const RenderingData::Target::RenderListNode& list,
	const WebSpike::PrimitiveRecord& base,
	const RenderingData::RenderListNode::Instance& instance,
	const GeometrySet& geometries, InstanceBinding* out )
{
	memset( out, 0, sizeof( *out ) );
	out->vbBlock = -1;
	out->vbIndex = -1;
	out->ibBlock = -1;
	out->ibIndex = -1;
	out->vertexSource = -1;
	out->indexSource = -1;

	const WebSpike::DrawListState& draws = WebSpike::Draws();

	if ( base.declaration < 0 || base.declaration >= draws.declarations )
	{
		out->reason = "declarationOutOfRange";
		return;
	}

	const WebSpike::DeclRecord& decl = draws.decl[ base.declaration ];
	int positionStream = -1;
	int found = 0;

	for ( int e = 0; e < decl.count; e++ )
	{
		if ( decl.elements[ e ].usage == 0 && decl.elements[ e ].usageIndex == 0 )
		{
			if ( found )
			{
				out->reason = "duplicatePosition0";
				return;
			}

			positionStream = decl.elements[ e ].stream;
			++found;
		}
	}

	if ( found == 0 )
	{
		out->reason = "noPosition0";
		return;
	}

	if ( positionStream < 0 || positionStream >= 16 )
	{
		out->reason = "positionStreamOutOfRange";
		return;
	}

	StreamBinding slots[ 16 ];
	bool present[ 16 ];

	for ( int i = 0; i < 16; i++ )
		present[ i ] = false;

	// The reference reader allows an instance stream to be overridden by the
	// matching base-primitive stream. Same order, same result.
	for ( int s = 0; s < instance.primitiveStreams.Size(); s++ )
	{
		const RenderingData::RenderListNode::PrimitiveStream& stream =
			instance.primitiveStreams[ s ];

		if ( stream.streamIndex < 0 || stream.streamIndex >= 16 )
			continue;

		slots[ stream.streamIndex ].vertexBuffer = stream.vertexBuffer;
		slots[ stream.streamIndex ].vertexOffset = stream.vertexOffset;
		slots[ stream.streamIndex ].frequency = stream.frequency;
		slots[ stream.streamIndex ].materialIndex = stream.material.index;
		slots[ stream.streamIndex ].materialList = stream.material.listIndex;
		present[ stream.streamIndex ] = true;
	}

	for ( int s = 0; s < base.streamCount; s++ )
	{
		const WebSpike::StreamRecord& stream = base.streams[ s ];

		if ( stream.streamIndex < 0 || stream.streamIndex >= 16 )
			continue;

		slots[ stream.streamIndex ].vertexBuffer = stream.vertexBuffer;
		slots[ stream.streamIndex ].vertexOffset = stream.vertexOffset;
		slots[ stream.streamIndex ].frequency = stream.frequency;
		slots[ stream.streamIndex ].materialIndex = stream.materialIndex;
		slots[ stream.streamIndex ].materialList = stream.materialList;
		present[ stream.streamIndex ] = true;
	}

	if ( !present[ positionStream ] )
	{
		out->reason = "positionStreamNotBound";
		return;
	}

	const StreamBinding& selected = slots[ positionStream ];
	out->vertexSource = selected.vertexBuffer;

	if ( selected.vertexBuffer < 0 ||
		selected.vertexBuffer >= list.GetNumVertexBuffers() )
	{
		out->reason = "vertexSourceOutOfRange";
		return;
	}

	if ( base.indexBuffer < 0 || base.indexBuffer >= list.GetNumIndexBuffers() )
	{
		out->reason = "indexSourceOutOfRange";
		return;
	}

	const RenderingData::ResourceIndex vertexIndex =
		list.GetVertexBufferSource( selected.vertexBuffer );
	const RenderingData::ResourceIndex indexIndex =
		list.GetIndexBufferSource( base.indexBuffer );

	out->vbBlock = vertexIndex.GetBlock();
	out->vbIndex = vertexIndex.GetIndex();
	out->ibBlock = indexIndex.GetBlock();
	out->ibIndex = indexIndex.GetIndex();
	out->indexSource = base.indexBuffer;

	const GeometryView* geometry = findGeometry( geometries, out->vbBlock );

	if ( geometry == 0 || out->ibBlock != geometry->block )
	{
		const char* unsupported = unsupportedGeometryReason( geometries,
			out->vbBlock );
		out->reason = unsupported ? unsupported : "geometryBlockNotImported";
		return;
	}

	if ( !geometry->valid )
	{
		out->reason = "geometryResourcesMissing";
		return;
	}

	if ( out->vbIndex < 0 || out->vbIndex >= geometry->vertexBufferCount )
	{
		out->reason = "vertexBufferNotImported";
		return;
	}

	if ( out->ibIndex < 0 || out->ibIndex >= geometry->indexBufferCount )
	{
		out->reason = "indexBufferNotImported";
		return;
	}

	if ( base.lodCount == 0 )
	{
		out->reason = "primitiveHasNoLod";
		return;
	}

	const WebSpike::BufferRecord& vb = geometry->vertexBuffers[ out->vbIndex ];
	const WebSpike::BufferRecord& ib = geometry->indexBuffers[ out->ibIndex ];
	const WebSpike::LodRecord& lod = base.lods[ 0 ];
	out->vb = &vb;
	out->ib = &ib;
	out->lod = &lod;

	if ( selected.frequency != 0 )
	{
		out->reason = "unsupportedInstanceStreamFrequency";
		return;
	}

	if ( selected.vertexOffset < 0 )
	{
		out->reason = "negativeInstanceStreamOffset";
		return;
	}

	if ( vb.compression != 0 || ib.compression != 0 )
	{
		out->reason = "compressedBuffer";
		return;
	}

	if ( !ib.payloadRetained )
	{
		out->reason = "indexPayloadNotRetained";
		return;
	}

	if ( vb.stride <= 0 || ib.stride <= 0 )
	{
		out->reason = "zeroBufferStride";
		return;
	}

	if ( lod.offset < 0 || lod.indices < 0 || lod.offset > ib.count ||
		lod.indices > ib.count - lod.offset )
	{
		out->reason = "indexRangeOutOfBuffer";
		return;
	}

	if ( lod.minIndex < 0 || lod.vertices < 0 || lod.minIndex > vb.count ||
		lod.vertices > vb.count - lod.minIndex )
	{
		out->reason = "vertexRangeOutOfBuffer";
		return;
	}

	if ( selected.vertexOffset % vb.stride != 0 )
	{
		out->reason = "unalignedVertexStreamOffset";
		return;
	}

	out->vertexShift = selected.vertexOffset / vb.stride;

	if ( out->vertexShift > vb.count )
	{
		out->reason = "vertexShiftOutOfBuffer";
		return;
	}

	if ( base.topology != 0 && base.topology != 1 )
	{
		out->reason = "unsupportedTopology";
		return;
	}

	if ( base.topology == 0 && ( lod.indices % 3 ) != 0 )
	{
		out->reason = "triangleListIndexCount";
		return;
	}

	const U8* payload = (const U8*)draws.arena + ib.payloadOffset;

	for ( int j = 0; j < lod.indices; j++ )
	{
		U32 value;

		if ( ib.stride == 2 )
			value = (U32)( (const U16*)payload )[ lod.offset + j ];
		else
			value = ( (const U32*)payload )[ lod.offset + j ];

		if ( value < (U32)lod.minIndex ||
			value >= (U32)( lod.minIndex + lod.vertices ) ||
			value >= (U32)( vb.count - out->vertexShift ) )
		{
			out->reason = "indexOutsidePrimitiveRange";
			return;
		}
	}

	out->valid = true;
	out->reason = "none";
}

int countInstanceTriangles( const InstanceBinding& binding, int topology )
{
	int triangles = 0;
	const U8* payload = (const U8*)WebSpike::Draws().arena +
		binding.ib->payloadOffset;

	if ( topology == 0 )
	{
		for ( int j = 0; j + 2 < binding.lod->indices; j += 3 )
		{
			U32 i0, i1, i2;

			if ( binding.ib->stride == 2 )
			{
				i0 = (U32)( (const U16*)payload )[ binding.lod->offset + j ];
				i1 = (U32)( (const U16*)payload )[ binding.lod->offset + j + 1 ];
				i2 = (U32)( (const U16*)payload )[ binding.lod->offset + j + 2 ];
			}
			else
			{
				i0 = ( (const U32*)payload )[ binding.lod->offset + j ];
				i1 = ( (const U32*)payload )[ binding.lod->offset + j + 1 ];
				i2 = ( (const U32*)payload )[ binding.lod->offset + j + 2 ];
			}

			if ( i0 == i1 || i1 == i2 || i0 == i2 )
				continue;

			++triangles;
		}
	}
	else
	{
		for ( int j = 2; j < binding.lod->indices; j++ )
		{
			U32 i0, i1, i2;

			if ( binding.ib->stride == 2 )
			{
				i0 = (U32)( (const U16*)payload )[ binding.lod->offset + j - 2 ];
				i1 = (U32)( (const U16*)payload )[ binding.lod->offset + j - 1 ];
				i2 = (U32)( (const U16*)payload )[ binding.lod->offset + j ];
			}
			else
			{
				i0 = ( (const U32*)payload )[ binding.lod->offset + j - 2 ];
				i1 = ( (const U32*)payload )[ binding.lod->offset + j - 1 ];
				i2 = ( (const U32*)payload )[ binding.lod->offset + j ];
			}

			if ( j % 2 )
			{
				const U32 swap = i0;
				i0 = i1;
				i1 = swap;
			}

			if ( i0 == i1 || i1 == i2 || i0 == i2 )
				continue;

			++triangles;
		}
	}

	return triangles;
}

// The committed Stage B reader reports vertexCount as the number of distinct
// source vertex indices actually referenced by the instance's LOD0 span, not
// the whole minIndex..minIndex+vertices-1 range. For block 27 the two coincide;
// for blocks 15/17/26/32 the range contains vertices no index uses. Counting
// only the referenced set is what keeps the 56-stage total at 34,632.
int countInstanceUsedVertices( const InstanceBinding& binding )
{
	std::vector<U32> used;
	used.reserve( (size_t)binding.lod->indices );

	const U8* payload = (const U8*)WebSpike::Draws().arena +
		binding.ib->payloadOffset;

	for ( int j = 0; j < binding.lod->indices; j++ )
	{
		if ( binding.ib->stride == 2 )
			used.push_back(
				(U32)( (const U16*)payload )[ binding.lod->offset + j ] );
		else
			used.push_back(
				( (const U32*)payload )[ binding.lod->offset + j ] );
	}

	std::sort( used.begin(), used.end() );
	used.erase( std::unique( used.begin(), used.end() ), used.end() );
	return (int)used.size();
}

void emitInstanceNode( RenderingData::Target::ResourceBlock::Resources* resources,
	const ChunkRange& range, const GeometrySet& geometries, int primitiveBase,
	DrawTotals* totals, PacketState* packet )
{
	const WebSpike::DrawListState& draws = WebSpike::Draws();
	int primitiveCursor = 0;

	for ( int n = 0; n < resources->nodes.Size(); n++ )
	{
		RenderingData::Node* node = Pointer( resources->nodes[ n ] );

		if ( node == 0 )
			continue;

		++totals->nodes;

		if ( !node->IsNode( RenderingData::NODE_TYPE_RENDER_LIST_PLATFORM ) )
		{
			printf( "webfiledraw node %d type=%d renderlist=0\n", n,
				(int)node->GetNodeType() );
			continue;
		}

		RenderingData::Target::RenderListNode* list =
			static_cast<RenderingData::Target::RenderListNode*>( node );

		const int numPrimitives = list->GetNumPrimitives();
		const int numInstances = list->GetNumInstances();
		const int numBasePrimitives = list->GetNumBasePrimitives();

		++totals->renderLists;
		totals->primitives += numPrimitives;
		totals->instances += numInstances;
		totals->basePrimitives += numBasePrimitives;

		printf( "webfiledraw list node=%d primitives=%d instances=%d "
			"baseprimitives=%d instancebatches=%d dynamiclists=%d\n", n,
			numPrimitives, numInstances, numBasePrimitives,
			list->GetNumInstanceBatches(), list->GetNumDynamicMaterialLists() );

		MaterialInventory inventory;
		inventoryMaterials( *list, &inventory );
		packet->materialRows += inventory.rows;
		packet->materialTypes += inventory.types;
		packet->materialAlbedoRows += inventory.albedoRows;
		packet->materialWorldRows += inventory.worldRows;
		packet->materialType8Rows += inventory.type8Rows;
		printf( "webfiledraw material node=%d chunk=%d types=%d rows=%d "
			"worldRows=%d albedoRows=%d type8Rows=%d runtimeRows=%d externalRows=%d\n",
			n, (int)range.chunk, inventory.types, inventory.rows,
			inventory.worldRows, inventory.albedoRows, inventory.type8Rows,
			inventory.runtimeRows, inventory.externalRows );

		const int baseStart = primitiveBase + primitiveCursor + numPrimitives;

		for ( int i = 0; i < numInstances; i++ )
		{
			const RenderingData::RenderListNode::Instance& instance =
				list->GetInstance( i );

			PacketRecord packetRecord;
			initPacketRecord( &packetRecord, 1, packet->records );
			packetRecord.instanceIndex = i;
			packetRecord.primitiveIndex = instance.primitiveIndex;

			MaterialProbe probe;
			initMaterialProbe( &probe );
			applyMaterial( *list, &probe, instance.material.index,
				instance.material.listIndex );

			for ( int s = 0; s < instance.primitiveStreams.Size(); s++ )
			{
				const RenderingData::RenderListNode::PrimitiveStream& stream =
					instance.primitiveStreams[ s ];

				if ( stream.streamIndex == -1 )
					continue;
				applyMaterial( *list, &probe, stream.material.index,
					stream.material.listIndex );
			}

			const int baseIndex = baseStart + instance.primitiveIndex;
			const WebSpike::PrimitiveRecord* base =
				( baseIndex >= 0 && baseIndex < draws.primitives )
				? &draws.primitive[ baseIndex ] : 0;

			if ( base != 0 )
			{
				applyMaterial( *list, &probe, base->baseMaterialIndex,
					base->baseMaterialList );

				for ( int s = 0; s < base->streamCount; s++ )
				{
					if ( base->streams[ s ].streamIndex == -1 )
						continue;
					applyMaterial( *list, &probe,
						base->streams[ s ].materialIndex,
						base->streams[ s ].materialList );
				}
			}

			const char* wReason = worldReason( probe );
			packetRecord.worldValid = strcmp( wReason, "none" ) == 0;
			packetRecord.worldRow = probe.worldRow;

			if ( packetRecord.worldValid )
			{
				memcpy( packetRecord.world, probe.world,
					sizeof( packetRecord.world ) );
				++packet->instanceWorlds;
			}
			else
			{
				packetRecord.worldReason = wReason;
				++packet->instanceWorldInvalid;
			}

			resolveAlbedo( *list, probe, &packetRecord );

			InstanceBinding binding;
			memset( &binding, 0, sizeof( binding ) );
			binding.vbBlock = -1;
			binding.vbIndex = -1;
			binding.ibBlock = -1;
			binding.ibIndex = -1;
			binding.reason = "primitiveRecordMissing";

			int triangleCount = 0;

			if ( base != 0 )
			{
				bindInstanceGeometry( *list, *base, instance, geometries,
					&binding );
				packetRecord.sourceOffset = base->streamOffset;
				packetRecord.layer = base->blendEnable ? "alpha" : "opaque";

				if ( binding.valid )
				{
					packetRecord.vertexOffset = binding.lod->minIndex +
						binding.vertexShift;
					packetRecord.vertexCount = binding.lod->vertices;
					packetRecord.indexOffset = binding.lod->offset;
					packetRecord.indexCount = binding.lod->indices;
					triangleCount = countInstanceTriangles( binding,
						base->topology );
					const int usedVertexCount =
						countInstanceUsedVertices( binding );

					totals->triangles += triangleCount;
					totals->triangleIndices += triangleCount * 3;
					// The committed instance readers report the number of
					// distinct referenced source vertices, not the raw LOD
					// vertex-range width.
					totals->vertices += usedVertexCount;

					// P32: the P30 result (block 27 alone) is kept as a
					// regression subset inside the extended 56-stage list.
					if ( binding.vbBlock == 27 )
					{
						++totals->instanceBlock27Draws;
						totals->instanceBlock27Triangles += triangleCount;
						totals->instanceBlock27Vertices += usedVertexCount;
					}
				}
			}

			packetRecord.vbBlock = binding.vbBlock;
			packetRecord.vbIndex = binding.vbIndex;
			packetRecord.ibBlock = binding.ibBlock;
			packetRecord.ibIndex = binding.ibIndex;
			packetRecord.bounds = list->GetInstanceBounds() != 0
				? &list->GetInstanceBounds( i ) : 0;
			packetRecord.drawable = binding.valid;
			packetRecord.reason = binding.valid ? "none" : binding.reason;
			snprintf( packetRecord.mesh, sizeof( packetRecord.mesh ),
				"river.b%d.vb%d.b%d.ib%d", (int)binding.vbBlock,
				(int)binding.vbIndex, (int)binding.ibBlock, (int)binding.ibIndex );

			++packet->records;
			++packet->instanceRecords;

			if ( binding.valid )
			{
				++packet->instanceDrawable;
				++packet->drawable;
			}
			else
			{
				++packet->omitted;
				if ( binding.reason &&
					( strcmp( binding.reason,
						"geometryBlockNotImported" ) == 0 ||
						strcmp( binding.reason,
							"geometryBlockPrerequisite" ) == 0 ) )
					++packet->instanceOtherBlock;
			}

			if ( packetRecord.materialId[ 0 ] ) ++packet->instanceMaterials;
			else ++packet->instanceMaterialNull;

			if ( binding.vbBlock >= 0 && binding.ibBlock >= 0 &&
				binding.vbIndex >= 0 && binding.ibIndex >= 0 )
				++packet->instanceSources;

			printf( "webfiledraw instance %d chunk=%d nodeIndex=%d "
				"primitiveIndex=%d base=%d material=%d:%d flags=0x%08x "
				"streams=%d world=%s worldRow=%d materialId=%s "
				"materialReason=%s vb=%d:%d ib=%d:%d vtxCount=%d idxCount=%d "
				"triangles=%d drawable=%d reason=%s\n",
				i, (int)range.chunk, n, (int)instance.primitiveIndex,
				baseIndex, (int)instance.material.index,
				(int)instance.material.listIndex, (unsigned)instance.flags,
				(int)instance.primitiveStreams.Size(),
				packetRecord.worldValid ? "ok" : "null", probe.worldRow,
				packetRecord.materialId[ 0 ] ? packetRecord.materialId : "null",
				packetRecord.materialReason, (int)binding.vbBlock,
				(int)binding.vbIndex, (int)binding.ibBlock, (int)binding.ibIndex,
				packetRecord.vertexCount, packetRecord.indexCount,
				triangleCount, packetRecord.drawable ? 1 : 0,
				packetRecord.reason );

			emitPacketRecord( packet, packetRecord );
		}

		primitiveCursor += numPrimitives + numBasePrimitives;
	}
}

} // namespace

int main( int argc, char** argv )
{
	setvbuf( stdout, 0, _IONBF, 0 );
	setvbuf( stderr, 0, _IONBF, 0 );

	if ( argc < 4 )
	{
		printf( "usage: node stream_harness.js <levelrender> <levelstream> "
			"<levelphysics>\n" );
		return 2;
	}

	printf( "webfile abi=%u expected=%u\n", (unsigned)pf_abi_version(),
		(unsigned)PF_ABI_VERSION );
	check( "abi_version", pf_abi_version() == PF_ABI_VERSION );

	Sys::C_WebFileSystem filesystem;
	const bool mountRender =
		filesystem.Mount( Sys::C_FilePath( kRenderPath ), "blob:levelrender" );
	const bool mountStream =
		filesystem.Mount( Sys::C_FilePath( kStreamPath ), "blob:levelstream" );
	const bool mountPhysics =
		filesystem.Mount( Sys::C_FilePath( kPhysicsPath ), "blob:levelphysics" );
	printf( "webfile mount render=%d stream=%d physics=%d\n",
		mountRender ? 1 : 0, mountStream ? 1 : 0, mountPhysics ? 1 : 0 );
	check( "mount", mountRender && mountStream && mountPhysics );

	Sys::SetDefaultFileSystem( &filesystem );

	// The game's overlay above the read layer, exactly as T-005b mounted
	// cache/root.pak: one read-only E_Type_Newer layer at "/".
	LogicalFs::C_OverlayFs overlay;
	overlay.SetWorkingDirectory( "/" );
	LogicalFs::C_OverlayLayer::C_Params params;
	params.flags.layerType = LogicalFs::C_OverlayLayer::E_Type_Newer;
	params.flags.writable = 0;
	overlay.AddLayer( Sys::C_FilePath( "/" ), &filesystem, Sys::C_FilePath( "/" ),
		params, LogicalFs::E_MediaLayer_0, "game-data/Blur/levels/usa_la_river" );
	check( "overlay_mount", overlay.GetNumLayers( LogicalFs::E_MediaLayer_0 ) == 1 );

	check( "exists_render", overlay.FileExists( Sys::C_FilePath( kRenderPath ) ) );
	check( "exists_stream", overlay.FileExists( Sys::C_FilePath( kStreamPath ) ) );
	check( "exists_physics", overlay.FileExists( Sys::C_FilePath( kPhysicsPath ) ) );

	// The three files through the engine overlay. Levelrender and levelphysics
	// are indexed/checked by the committed probes; here they prove the engine
	// file path reaches the same bytes.
	const FileHash render = hash_file( overlay, kRenderPath, 16 * 1024 );
	const FileHash physics = hash_file( overlay, kPhysicsPath, 16 * 1024 );
	check( "render_read", render.ok && render.bytes > 0 );
	check( "physics_read", physics.ok && physics.bytes > 0 );

	// --- the engine archive path: Level.levelrender -> Target::Scene ---------
	// Sys::C_FileBlock walks the level's Render block (the traversal
	// C_RenderLevel::Read performs), then the engine's own
	// Arch::BinaryInputArchive reads the Scene object, including StreamData and
	// all 359 ChunkInfo records through archive.inl's serialiser.
	WebSpike::SceneReport& report = WebSpike::Report();
	// P27: the declaration table is filled while the Scene archive is read, so
	// the draw-list state must start empty here.
	WebSpike::ResetDrawList();

	Sys::I_File* renderFile = overlay.Open( Sys::C_FilePath( kRenderPath ),
		Sys::E_FileAccess_Read, Sys::C_OpenParams( 64 * 1024 ) );
	check( "render_open", renderFile != 0 );
	if ( !renderFile )
	{
		printf( "webfile done checks=%d failures=%d\n", gChecks, gFailures );
		return 1;
	}

	RenderingData::Target::Scene* scene = new RenderingData::Target::Scene();
	bool sceneParsed = false;
	S32 readSceneVersion = -1;
	U64 scenePayloadAbs = 0;
	U64 sceneCursorAbs = 0;

	// P27 loaded-block import results (read inside the Scene block scope).
	S32 loadedBlocks = 0;
	S32 loadedLod = -1;
	S32 loadedVb = 0;
	S32 loadedIb = 0;
	S32 loadedNodes = 0;
	S32 loadedTextures = 0;
	bool loadedOk = false;

	{
		// The level loader consumes the four-byte "  CP" file magic before
		// C_RenderLevel::Read builds its root FileBlock (the probes' level
		// reader does the same). C_FileBlock then walks the Render block.
		U8 magic[ 4 ] = { 0, 0, 0, 0 };
		renderFile->SetPosition( 0 );
		const bool magicOk = renderFile->Read( magic, 4 ) &&
			memcmp( magic, "  CP", 4 ) == 0;
		check( "level_magic", magicOk );

		Sys::C_FileBlock rootBlock( renderFile );
		printf( "webfile level root=%s length=%llu\n", rootBlock.HeaderId().Chars(),
			(unsigned long long)rootBlock.Length() );
		if ( strcmp( rootBlock.HeaderId().Chars(), "Render" ) == 0 )
		{
			while ( rootBlock.GetPosition() < rootBlock.Length() )
			{
				const U64 blockStartAbs = renderFile->GetPosition();
				Sys::C_FileBlock block( &rootBlock );

				if ( strcmp( block.HeaderId().Chars(), "Scene" ) == 0 )
				{
					const U64 sceneBodyBytes = block.Length() - block.GetPosition();
					Arch::BinaryInputArchive ar( block );
					ar >> readSceneVersion;
					WebSpike::ParseSceneArchive( ar, *scene );
					S32 nBlocks = 0;
					ar >> nBlocks;
					report.resourceBlockCount = nBlocks;

					const U64 sceneConsumed = block.GetPosition() - 16;
					scenePayloadAbs = blockStartAbs + 16;
					sceneCursorAbs = blockStartAbs + (U64)block.GetPosition();
					sceneParsed = true;
					printf( "webfile scene version=%d blocks=%d cursor=%llu "
						"payload=%llu body=%llu consumed=%llu\n",
						(int)readSceneVersion, (int)nBlocks,
						(unsigned long long)sceneCursorAbs,
						(unsigned long long)scenePayloadAbs,
						(unsigned long long)sceneBodyBytes,
						(unsigned long long)sceneConsumed );
					// A truncated or over-read archive is an explicit check
					// failure, not a silently accepted prefix.
					check( "scene_bounds", sceneConsumed <= sceneBodyBytes );

					// P27: the bytes after the loaded-block count are the
					// initially loaded resource blocks (WorldRender::ReadScene
					// reads exactly this loop). They are imported with the
					// data-only Deserialise(ResourceBlock).
					loadedBlocks = nBlocks;
					for ( S32 i = 0; i < nBlocks; i++ )
					{
						RenderingData::Target::ResourceBlock& rb =
							scene->GetResourceBlock( i );
						WebSpike::ParseLoadedResourceBlockArchive( ar, rb );
						loadedLod = rb.GetLod();
						loadedVb += rb.GetNumVertexBuffers();
						loadedIb += rb.GetNumIndexBuffers();
						loadedNodes += rb.GetNumNodes();
						loadedTextures += rb.GetNumTextures();
					}
					loadedOk = true;
					break;
				}
			}
		}
	}

	printf( "webfile scene declarations=%d elements=%d effects=%d "
		"sharedTextures=%d sharedTextureBytes=%llu streamVersion=%d "
		"chunks=%d items=%d prereqs=%d dependants=%d disabled=%d "
		"stored=%llu original=%llu handler=%d\n",
		report.vertexDeclarations, report.vertexDeclarationElements,
		report.effects, report.sharedTextures, report.sharedTextureBytes,
		report.streamVersion, report.streamChunks, report.streamItems,
		report.streamPrerequisites, report.streamDependants,
		report.chunksDisabledOverChunkAllocator,
		report.streamStoredBytes, report.streamOriginalBytes,
		report.renderListHandlerRegistered );
	check( "scene_parse", sceneParsed && readSceneVersion == 1 );
	check( "scene_declarations", report.vertexDeclarations > 0 &&
		report.vertexDeclarationElements > 0 );
	check( "scene_no_gpu", report.gpuCalls == 0 );
	check( "scene_chunk_count", report.streamChunks == 359 );
	check( "scene_stream_table", report.streamItems > 0 );

	// The engine's ChunkInfo table, field by field. verify_stream.py compares
	// every line against range_probe level and level_inspect --index; the table
	// hash covers the same fields in a compact form.
	uint64_t tableHash = fnv_begin();
	{
		const RenderingData::Target::StreamData& table = scene->GetStreamData();
		fnv_u32( tableHash, (U32)table.GetNumChunks() );
		for ( int i = 0; i < table.GetNumChunks(); i++ )
		{
			const RenderingData::ChunkInfo& info = table.GetChunkInfo( i );
			printf( "webfile chunkinfo %d offset=%llu stored=%llu logical=%llu items=",
				i, (unsigned long long)info.GetOffset(),
				(unsigned long long)info.GetCompressedSize(),
				(unsigned long long)info.GetOriginalSize() );
			for ( int k = 0; k < info.GetNumItems(); k++ )
				printf( "%s%d:%d", k ? "," : "", info.GetItem( k ).block,
					info.GetItem( k ).lod );
			printf( " prereqs=" );
			for ( int k = 0; k < info.GetNumPrerequisites(); k++ )
				printf( "%s%d", k ? "," : "", info.GetPrerequisite( k ) );
			printf( " blocks=%d\n", info.GetNumBlocks() );

			fnv_u32( tableHash, (U32)i );
			fnv_u64( tableHash, info.GetOffset() );
			fnv_u64( tableHash, info.GetCompressedSize() );
			fnv_u64( tableHash, info.GetOriginalSize() );
			fnv_u32( tableHash, (U32)info.GetNumItems() );
			for ( int k = 0; k < info.GetNumItems(); k++ )
			{
				fnv_u32( tableHash, (U32)info.GetItem( k ).block );
				fnv_u32( tableHash, (U32)info.GetItem( k ).lod );
			}
			fnv_u32( tableHash, (U32)info.GetNumPrerequisites() );
			for ( int k = 0; k < info.GetNumPrerequisites(); k++ )
				fnv_u32( tableHash, (U32)info.GetPrerequisite( k ) );
		}
	}
	printf( "webfile scene_cursor absolute=%llu payload=%llu tablehash=0x%016llx\n",
		(unsigned long long)sceneCursorAbs, (unsigned long long)scenePayloadAbs,
		(unsigned long long)tableHash );

	// --- the streamer, driven by the engine table --------------------------
	Sys::I_File* stream = overlay.Open( Sys::C_FilePath( kStreamPath ),
		Sys::E_FileAccess_Read, Sys::C_OpenParams( 16 * 1024 ) );
	printf( "webfile open stream ok=%d length=%llu\n", stream ? 1 : 0,
		stream ? (unsigned long long)stream->Length() : 0ull );
	check( "stream_open", stream != 0 );
	if ( !stream )
	{
		delete scene;
		delete renderFile;
		printf( "webfile done checks=%d failures=%d\n", gChecks, gFailures );
		return 1;
	}

	const Scheduler::PolicyHandle policy = Scheduler::CreatePolicy( kStreamerPolicy );
	printf( "webfile stream policy=%d\n", (int)policy );
	check( "stream_policy", policy >= 0 );
	Scheduler::Init();
	Scheduler::Start();
	Scheduler::SetGroupPoolSize( kGroupPool );

	RenderingData::Target::StreamManager& manager =
		RenderingData::Target::StreamManager::Instance();
	printf( "webfile stream maxChunk=%d\n", (int)manager.MaxChunkSize() );
	check( "chunk_allocator", manager.MaxChunkSize() == 4 * 1024 * 1024 );
	manager.Create();
	manager.SetJobQueuePolicy( policy );

	U64 totalBytes = 0;
	U64 largest = 0;
	U32 hashFailures = 0;
	U32 readFailures = 0;
	{
		const RenderingData::Target::StreamData& table = scene->GetStreamData();
		for ( int i = 0; i < table.GetNumChunks(); i++ )
		{
			const RenderingData::ChunkInfo& info = table.GetChunkInfo( i );
			uint64_t hash = 0;
			const bool ok = stream_one_chunk( manager, stream, i, info.GetOffset(),
				info.GetCompressedSize(), &hash );
			if ( !ok )
			{
				++readFailures;
				printf( "webfile chunk %d FAILED offset=%llu bytes=%llu\n", i,
					(unsigned long long)info.GetOffset(),
					(unsigned long long)info.GetCompressedSize() );
				continue;
			}
			totalBytes += info.GetCompressedSize();
			largest = std::max<U64>( largest, info.GetCompressedSize() );
			printf( "webfile chunk %d offset=%llu bytes=%llu hash=0x%016llx\n",
				i, (unsigned long long)info.GetOffset(),
				(unsigned long long)info.GetCompressedSize(),
				(unsigned long long)hash );
			if ( hash == 0 )
				++hashFailures;
		}
	}

	printf( "webfile stream summary chunks=%d bytes=%llu largest=%llu "
		"readFailures=%u hashFailures=%u\n",
		scene->GetStreamData().GetNumChunks(), (unsigned long long)totalBytes,
		(unsigned long long)largest, readFailures, hashFailures );
	check( "stream_chunk_count", scene->GetStreamData().GetNumChunks() == 359 );
	check( "stream_all_read", readFailures == 0 );
	check( "stream_bytes", totalBytes == stream->Length() );
	check( "stream_largest", largest <= (U64)manager.MaxChunkSize() );
	check( "stream_no_requests", manager.GetNumRequests() == 0 );

	// --- StreamData::OpenStreamFile + CacheChunk ---------------------------
	{
		RenderingData::Target::StreamData& streamData = scene->GetStreamData();
		streamData.OpenStreamFile( Btl::String( kStreamPath ) );
		printf( "webfile openstream opened=%d hint=%d\n",
			report.streamFileOpened, report.streamFileBufferHint );
		check( "streamdata_open", report.streamFileOpened == 1 );

		// Chunk 0 has no prerequisites. CacheChunk performs the engine's own
		// LoadChunk(offset, compressedSize) from the parsed ChunkInfo.
		const RenderingData::ChunkInfo& first = streamData.GetChunkInfo( 0 );
		const bool cached = streamData.CacheChunkForWebGate( 0 );
		S32 index = -1;
		bool loadFailed = true;
		RenderingData::Target::StreamManager::AutoChunkPointer data =
			manager.GetChunkData( index, loadFailed );
		uint64_t cacheHash = 0;
		if ( cached && index == 0 && data != 0 && !loadFailed )
		{
			cacheHash = fnv_begin();
			fnv_bytes( cacheHash, &*data, (size_t)first.GetCompressedSize() );
		}
		printf( "webfile cachechunk returned=%d index=%d failed=%d "
			"offset=%llu bytes=%llu hash=0x%016llx\n",
			cached ? 1 : 0, (int)index, loadFailed ? 1 : 0,
			(unsigned long long)first.GetOffset(),
			(unsigned long long)first.GetCompressedSize(),
			(unsigned long long)cacheHash );
		check( "cachechunk", cached && index == 0 && !loadFailed &&
			cacheHash != 0 );

		// A chunk with prerequisites must be refused, not read out of order.
		S32 withPrereq = -1;
		for ( int i = 0; i < scene->GetStreamData().GetNumChunks(); i++ )
		{
			if ( scene->GetStreamData().GetChunkInfo( i ).GetNumPrerequisites() )
			{
				withPrereq = i;
				break;
			}
		}
		const bool refused = withPrereq >= 0 && !streamData.CacheChunkForWebGate( withPrereq );
		printf( "webfile cachechunk_prereq index=%d refused=%d\n", (int)withPrereq,
			refused ? 1 : 0 );
		check( "cachechunk_prereq", refused );

		streamData.CloseStreamFile();
	}

	// --- P27: CPU-side draw list from the engine's own resource import ------
	// Nothing below creates a GPU object. The inline loaded resource block is
	// read with Deserialise(ResourceBlock); the streamed geometry and node
	// chunks are read with the same LodReader<ResourceBlock::Resources>
	// deserialiser ProcessLoadChunk uses. Buffers are descriptors plus retained
	// payload bytes; render lists are real RenderListNode objects whose
	// primitives were deserialised into PrimitiveRecord entries.
	{
		WebSpike::ResetChunkRecords();

		const S32 nLoadedBlocks = loadedBlocks;
		printf( "webfiledraw inline blocks=%d lod=%d vbs=%d ibs=%d nodes=%d "
			"textures=%d gpu=%d\n", (int)nLoadedBlocks, (int)loadedLod,
			(int)loadedVb, (int)loadedIb, (int)loadedNodes, (int)loadedTextures,
			WebSpike::Draws().gpuObjectsCreated );
		check( "drawlist_inline_block",
			loadedOk && nLoadedBlocks == 1 && WebSpike::Draws().gpuObjectsCreated == 0 );

		PacketState packet;
		memset( &packet, 0, sizeof( packet ) );
		packet.hash = fnv_begin();

		// The two blocks compared with the asset-reader reference: River
		// geometry block 88 and node block 283 (95 direct draws), and node
		// block 253 (57 instances) whose geometry is block 27.
		const S32 kGeometryBlock = 88;
		const S32 kNodeBlock = 283;
		const S32 kInstanceNodeBlock = 253;

		static WebSpike::BufferRecord geoVb[ WebSpike::kMaxBuffers ];
		static WebSpike::BufferRecord geoIb[ WebSpike::kMaxBuffers ];
		int geoVbCount = 0;
		int geoIbCount = 0;
		S32 geoNodeCount = 0;
		S32 geoTextureCount = 0;

		bool geometryOk = false;
		{
			ChunkRange range;
			const bool located = findChunkItem( scene->GetStreamData(), kGeometryBlock,
				0, &range );
			printf( "webfiledraw chunk name=geometry block=%d chunk=%d item=%d "
				"lod=%d offset=%llu bytes=%llu located=%d\n", (int)kGeometryBlock,
				(int)range.chunk, (int)range.item, (int)range.lod,
				(unsigned long long)range.offset,
				(unsigned long long)range.bytes, located ? 1 : 0 );
			check( "drawlist_geometry_located", located );

			if ( located )
			{
				std::vector<U8> bytes;
				int vbBase = 0;
				int ibBase = 0;
				int primBase = 0;
				RenderingData::Target::ResourceBlock::Resources* resources =
					loadChunkCopy( manager, stream, range, bytes )
					? parseChunkItem( bytes, scene, range, &vbBase, &ibBase, &primBase )
					: 0;
				geometryOk = resources != 0;

				const WebSpike::DrawListState& draws = WebSpike::Draws();
				// A chunk can hold several resource items. The target item's
				// buffers start at vbBase/ibBase; only those belong to this
				// block and only they use the reference's 0-based indices.
				geoVbCount = draws.vertexBuffers - vbBase;
				geoIbCount = draws.indexBuffers - ibBase;
				geoNodeCount = draws.resourceNodes;
				geoTextureCount = draws.resourceTextures;

				for ( int i = 0; i < geoVbCount && i < WebSpike::kMaxBuffers; i++ )
					geoVb[ i ] = draws.vertexBuffer[ vbBase + i ];
				for ( int i = 0; i < geoIbCount && i < WebSpike::kMaxBuffers; i++ )
					geoIb[ i ] = draws.indexBuffer[ ibBase + i ];

				printf( "webfiledraw chunk name=geometry parsed=%d vbs=%d ibs=%d "
					"nodes=%d textures=%d retained=%d compressed=%d\n",
					geometryOk ? 1 : 0, geoVbCount, geoIbCount, (int)geoNodeCount,
					(int)geoTextureCount, draws.arenaUsed, draws.compressedBuffers );

				for ( int i = 0; i < geoVbCount; i++ )
					printf( "webfiledraw vbuf %d count=%d stride=%d bytes=%d "
						"align=%d compression=%d endian=%d payload=%d\n", i,
						geoVb[ i ].count, geoVb[ i ].stride, geoVb[ i ].bytes,
						geoVb[ i ].alignment, geoVb[ i ].compression,
						geoVb[ i ].endianSwap, geoVb[ i ].payloadRetained );
				for ( int i = 0; i < geoIbCount; i++ )
					printf( "webfiledraw ibuf %d count=%d width=%d bytes=%d "
						"align=%d compression=%d endian=%d payload=%d\n", i,
						geoIb[ i ].count, geoIb[ i ].stride, geoIb[ i ].bytes,
						geoIb[ i ].alignment, geoIb[ i ].compression,
						geoIb[ i ].endianSwap, geoIb[ i ].payloadRetained );

				check( "drawlist_geometry_import",
					geometryOk && geoVbCount > 0 && geoIbCount > 0 &&
					draws.compressedBuffers == 0 && draws.arenaExhausted == 0 );
			}
		}

		GeometryView geometry;
		geometry.block = kGeometryBlock;
		geometry.valid = geometryOk;
		geometry.vertexBuffers = geoVb;
		geometry.vertexBufferCount = geoVbCount;
		geometry.indexBuffers = geoIb;
		geometry.indexBufferCount = geoIbCount;

		// Node block 283: the 95 direct draws.
		{
			WebSpike::ResetChunkRecords();
			// The geometry payloads live in the arena; ResetChunkRecords keeps
			// them and only clears the record tables.

			ChunkRange range;
			const bool located = findChunkItem( scene->GetStreamData(), kNodeBlock, 0,
				&range );
			printf( "webfiledraw chunk name=node block=%d chunk=%d item=%d "
				"lod=%d offset=%llu bytes=%llu located=%d\n", (int)kNodeBlock,
				(int)range.chunk, (int)range.item, (int)range.lod,
				(unsigned long long)range.offset,
				(unsigned long long)range.bytes, located ? 1 : 0 );
			check( "drawlist_node_located", located );

			if ( located )
			{
				std::vector<U8> bytes;
				RenderingData::Target::ResourceBlock::Resources* resources =
					loadChunkCopy( manager, stream, range, bytes )
					? parseChunkItem( bytes, scene, range, 0, 0, 0 ) : 0;
				const bool parsed = resources != 0;
				check( "drawlist_node_import", parsed );

				DrawTotals totals;
				memset( &totals, 0, sizeof( totals ) );
				totals.hash = fnv_begin();

				if ( parsed )
					emitNodeDraws( resources, range, geometry, &totals, &packet );

				printf( "webfiledraw summary node=%d nodes=%d primitives=%d "
					"renderlists=%d draws=%d otherblock=%d unbound=%d "
					"triangles=%d vertices=%d indexerrors=%d drawhash=0x%016llx\n",
					(int)kNodeBlock, totals.nodes, totals.primitives,
					totals.renderLists, totals.draws, totals.otherBlock,
					totals.unbound, totals.triangles, totals.vertices,
					totals.indexErrors, (unsigned long long)totals.hash );

				check( "drawlist_draws", totals.draws == 95 );
				check( "drawlist_triangles", totals.triangles == 9343 );
				check( "drawlist_vertices", totals.vertices == 17782 );
				check( "drawlist_no_index_errors", totals.indexErrors == 0 );

				delete resources;
			}
		}

		// --- P32: Stage A+B instance geometry (blocks 15/17/26/27/32) ------
		// The five supplied geometry blocks live in three stream chunks. Each
		// chunk is parsed once, up to the highest item the bundle needs, and
		// every item's own buffer slice is recorded before the next chunk
		// appends. Block 31 is deliberately not imported: its chunk declares
		// prerequisites, which this slice does not traverse.
		static const S32 kInstanceGeometryBlocks[ 5 ] = { 15, 17, 26, 27, 32 };

		GeometrySet instanceGeometries;
		memset( &instanceGeometries, 0, sizeof( instanceGeometries ) );

		WebSpike::ResetChunkRecords();

		// 1. The node chunk first, so its primitive records start at index 0.
		ChunkRange nodeRange;
		memset( &nodeRange, 0, sizeof( nodeRange ) );
		bool nodeLocated = false;
		RenderingData::Target::ResourceBlock::Resources* nodeResources = 0;
		int nodePrimitiveBase = 0;
		{
			nodeLocated = findChunkItem( scene->GetStreamData(),
				kInstanceNodeBlock, 0, &nodeRange );
			printf( "webfiledraw chunk name=instancenode block=%d chunk=%d item=%d "
				"lod=%d offset=%llu bytes=%llu located=%d\n",
				(int)kInstanceNodeBlock, (int)nodeRange.chunk,
				(int)nodeRange.item, (int)nodeRange.lod,
				(unsigned long long)nodeRange.offset,
				(unsigned long long)nodeRange.bytes, nodeLocated ? 1 : 0 );
			check( "drawlist_instance_node_located", nodeLocated );

			if ( nodeLocated )
			{
				std::vector<U8> bytes;
				nodeResources = loadChunkCopy( manager, stream, nodeRange, bytes )
					? parseChunkItem( bytes, scene, nodeRange, 0, 0,
						&nodePrimitiveBase ) : 0;
			}
		}

		// 2. Locate all five blocks, grouping them by chunk.
		ChunkRange geometryRanges[ 5 ];
		bool allBlocksLocated = true;

		for ( int k = 0; k < 5; k++ )
		{
			memset( &geometryRanges[ k ], 0, sizeof( geometryRanges[ k ] ) );
			const bool located = findChunkItem( scene->GetStreamData(),
				kInstanceGeometryBlocks[ k ], 0, &geometryRanges[ k ] );
			allBlocksLocated = allBlocksLocated && located;
			printf( "webfiledraw chunk name=instancegeometry block=%d chunk=%d "
				"item=%d lod=%d offset=%llu bytes=%llu located=%d\n",
				(int)kInstanceGeometryBlocks[ k ],
				(int)geometryRanges[ k ].chunk, (int)geometryRanges[ k ].item,
				(int)geometryRanges[ k ].lod,
				(unsigned long long)geometryRanges[ k ].offset,
				(unsigned long long)geometryRanges[ k ].bytes,
				located ? 1 : 0 );
		}
		check( "drawlist_instance_geometry_located", allBlocksLocated );

		// 3. Parse each distinct chunk once, up to its highest requested item.
		ItemBuffers parsedItems[ 64 ];
		int parsedItemCount = 0;
		int parsedChunks = 0;
		bool geometryParsed = allBlocksLocated;

		for ( int k = 0; k < 5 && geometryParsed; k++ )
		{
			const S32 chunk = geometryRanges[ k ].chunk;
			bool seen = false;

			for ( int j = 0; j < k; j++ )
				if ( geometryRanges[ j ].chunk == chunk )
					seen = true;

			if ( seen )
				continue;

			int maxItem = geometryRanges[ k ].item;

			for ( int j = k + 1; j < 5; j++ )
				if ( geometryRanges[ j ].chunk == chunk )
					maxItem = std::max<int>( maxItem, geometryRanges[ j ].item );

			std::vector<U8> bytes;

			if ( !loadChunkCopy( manager, stream, geometryRanges[ k ], bytes ) )
			{
				geometryParsed = false;
				break;
			}

			int produced = 0;

			if ( !parseChunkUpToItem( bytes, scene, geometryRanges[ k ], maxItem,
					parsedItems + parsedItemCount, &produced ) )
			{
				geometryParsed = false;
				break;
			}

			parsedItemCount += produced;
			++parsedChunks;
		}

		// 4. One view per supplied block, pointing at that item's own slice.
		int builtViews = 0;

		for ( int k = 0; k < 5; k++ )
		{
			const ItemBuffers* hit = 0;

			for ( int i = 0; i < parsedItemCount; i++ )
			{
				if ( parsedItems[ i ].block == kInstanceGeometryBlocks[ k ] )
					hit = &parsedItems[ i ];
			}

			GeometryView view;
			memset( &view, 0, sizeof( view ) );
			view.block = kInstanceGeometryBlocks[ k ];

			if ( hit != 0 )
			{
				view.valid = hit->vertexCount > 0 && hit->indexCount > 0;
				view.vertexBuffers =
					WebSpike::Draws().vertexBuffer + hit->vertexBase;
				view.vertexBufferCount = hit->vertexCount;
				view.indexBuffers =
					WebSpike::Draws().indexBuffer + hit->indexBase;
				view.indexBufferCount = hit->indexCount;
				++builtViews;
			}

			instanceGeometries.views[ instanceGeometries.count++ ] = view;
		}

		{
			const WebSpike::DrawListState& instDraws = WebSpike::Draws();
			printf( "webfiledraw chunk name=instancegeometry parsed=%d vbs=%d "
				"ibs=%d nodes=%d retained=%d compressed=%d blocks=%d chunks=%d "
				"items=%d\n",
				geometryParsed ? 1 : 0, instDraws.vertexBuffers,
				instDraws.indexBuffers, instDraws.resourceNodes,
				instDraws.arenaUsed, instDraws.compressedBuffers, builtViews,
				parsedChunks, parsedItemCount );

			check( "drawlist_instance_geometry_import",
				geometryParsed && builtViews == 5 &&
				instDraws.compressedBuffers == 0 &&
				instDraws.arenaExhausted == 0 );
		}

		// 5. Block 31 stays out with its prerequisite reason, not as an
		// unimported blank. Its chunk is reported but never loaded.
		{
			ChunkRange range;
			memset( &range, 0, sizeof( range ) );
			const bool located = findChunkItem( scene->GetStreamData(), 31, 0,
				&range );
			const RenderingData::ChunkInfo* info = located
				? &scene->GetStreamData().GetChunkInfo( range.chunk ) : 0;
			const int prerequisites = info ? info->GetNumPrerequisites() : 0;

			printf( "webfiledraw instancegeometry unsupported block=31 chunk=%d "
				"prerequisites=%d imported=0 reason=geometryBlockPrerequisite\n",
				located ? (int)range.chunk : -1, prerequisites );
			check( "drawlist_instance_geometry_prereq",
				located && info != 0 && prerequisites > 0 );

			instanceGeometries.unsupported[
				instanceGeometries.unsupportedCount ].block = 31;
			instanceGeometries.unsupported[
				instanceGeometries.unsupportedCount ].reason =
				"geometryBlockPrerequisite";
			++instanceGeometries.unsupportedCount;
		}

		// 6. Node block 253: the render list whose 57 instances are compared
		// with the committed Stage B reader. Each instance's constant affine
		// g_mWorld is read from the render list's constant material rows.
		if ( nodeResources != 0 )
		{
			DrawTotals totals;
			memset( &totals, 0, sizeof( totals ) );
			totals.hash = fnv_begin();

			emitInstanceNode( nodeResources, nodeRange, instanceGeometries,
				nodePrimitiveBase, &totals, &packet );

			printf( "webfiledraw instances node=%d renderlists=%d "
				"instanceCount=%d basePrimitives=%d draws=%d triangles=%d "
				"vertices=%d block27Draws=%d block27Triangles=%d "
				"block27Vertices=%d\n",
				(int)kInstanceNodeBlock, totals.renderLists, totals.instances,
				totals.basePrimitives, packet.instanceDrawable, totals.triangles,
				totals.vertices, totals.instanceBlock27Draws,
				totals.instanceBlock27Triangles, totals.instanceBlock27Vertices );
			check( "drawlist_instance_import",
				totals.renderLists > 0 && nodeLocated );
			check( "drawlist_instance_count", totals.instances == 57 );
			check( "drawlist_base_primitive_count",
				totals.basePrimitives == 36 );
			check( "drawlist_instance_triangles", totals.triangles == 25521 );
			check( "drawlist_instance_vertices", totals.vertices == 34632 );
			check( "drawlist_instance_block27_draws",
				totals.instanceBlock27Draws == 22 );
			check( "drawlist_instance_block27_triangles",
				totals.instanceBlock27Triangles == 10308 );
			check( "drawlist_instance_block27_vertices",
				totals.instanceBlock27Vertices == 13162 );

			delete nodeResources;
			nodeResources = 0;
		}

		printf( "webfiledraw packet summary records=%d drawable=%d omitted=%d "
			"direct=%d directDrawable=%d directOtherBlock=%d instance=%d "
			"instanceDrawable=%d instanceOtherBlock=%d worlds=%d worldInvalid=%d "
			"directWorldNull=%d directMaterials=%d directMaterialNull=%d "
			"instanceMaterials=%d instanceMaterialNull=%d instanceSources=%d "
			"materialRows=%d materialTypes=%d materialAlbedoRows=%d "
			"materialWorldRows=%d materialType8Rows=%d hash=0x%016llx\n",
			packet.records, packet.drawable,
			packet.records - packet.drawable, packet.directRecords,
			packet.directDrawable, packet.directOtherBlock, packet.instanceRecords,
			packet.instanceDrawable, packet.instanceOtherBlock,
			packet.instanceWorlds, packet.instanceWorldInvalid,
			packet.directWorldNull,
			packet.directMaterials, packet.directMaterialNull,
			packet.instanceMaterials, packet.instanceMaterialNull,
			packet.instanceSources, packet.materialRows, packet.materialTypes,
			packet.materialAlbedoRows, packet.materialWorldRows,
			packet.materialType8Rows, (unsigned long long)packet.hash );

		check( "packet_material_rows",
			packet.materialRows == 243 && packet.materialTypes == 26 );
		check( "packet_material_albedo", packet.materialAlbedoRows == 121 );
		check( "packet_material_world", packet.materialWorldRows == 38 );
		check( "packet_material_type8", packet.materialType8Rows == 0 );
		check( "packet_direct_material_ids", packet.directMaterials == 255 &&
			packet.directMaterialNull == 0 );
		check( "packet_instance_material_ids", packet.instanceMaterials == 57 &&
			packet.instanceMaterialNull == 0 );
		check( "packet_instance_worlds", packet.instanceWorlds == 57 );
		check( "packet_instance_world_affine", packet.instanceWorldInvalid == 0 );
		check( "packet_instance_sources", packet.instanceSources == 57 );
		check( "packet_direct_records", packet.directRecords == 255 );
		check( "packet_instance_records", packet.instanceRecords == 57 );
		check( "packet_records_total",
			packet.records == packet.directRecords + packet.instanceRecords );
		check( "packet_drawable", packet.directDrawable == 95 &&
			packet.instanceDrawable == 56 );
		check( "packet_instance_other_block",
			packet.instanceOtherBlock == 1 );
		check( "packet_direct_world_null",
			packet.directWorldNull == packet.directRecords );
		check( "packet_hash", packet.hash != 0 );

		const WebSpike::DrawListState& draws = WebSpike::Draws();
		printf( "webfiledraw counters declarations=%d vertexBuffers=%d "
			"indexBuffers=%d primitives=%d bufferOverflow=%d primitiveOverflow=%d "
			"lodOverflow=%d streamOverflow=%d declarationOverflow=%d "
			"arenaExhausted=%d gpuObjectsCreated=%d renderListHandler=%d\n",
			draws.declarations, draws.vertexBuffers, draws.indexBuffers,
			draws.primitives, draws.bufferOverflow, draws.primitiveOverflow,
			draws.lodOverflow, draws.streamOverflow, draws.declarationOverflow,
			draws.arenaExhausted, draws.gpuObjectsCreated,
			report.renderListHandlerRegistered );
		check( "drawlist_record_bounds",
			draws.bufferOverflow == 0 && draws.primitiveOverflow == 0 &&
			draws.lodOverflow == 0 && draws.streamOverflow == 0 &&
			draws.declarationOverflow == 0 );
		check( "drawlist_no_gpu_objects", draws.gpuObjectsCreated == 0 );
		check( "drawlist_renderlist_handler",
			report.renderListHandlerRegistered == 1 );
	}

	// --- explicit failures: a missing range is never zero filled -----------
	{
		// Crosses EOF: the 4 real bytes are read, the request still fails.
		const U64 size = stream->Length();
		const bool allocated = manager.LoadChunk( 9001, stream, size - 4, 16 );
		S32 index = -1;
		bool failed = false;
		RenderingData::Target::StreamManager::AutoChunkPointer data =
			manager.GetChunkData( index, failed );
		printf( "webfile eof index=%d failed=%d allocated=%d pointer=%d\n",
			(int)index, failed ? 1 : 0, allocated ? 1 : 0, data != 0 ? 1 : 0 );
		check( "eof_read_fails", allocated && failed && index == 9001 );

		// Starts past EOF.
		const bool allocated2 = manager.LoadChunk( 9002, stream, size, 16 );
		index = -1;
		failed = false;
		data = manager.GetChunkData( index, failed );
		printf( "webfile past_eof index=%d failed=%d allocated=%d\n",
			(int)index, failed ? 1 : 0, allocated2 ? 1 : 0 );
		check( "past_eof_read_fails", allocated2 && failed && index == 9002 );

		// One byte past the 4 MiB allocator: refused, no completion.
		const bool allocated3 = manager.LoadChunk( 9003, stream, 0,
			(U64)manager.MaxChunkSize() + 1 );
		index = -1;
		failed = false;
		data = manager.GetChunkData( index, failed );
		printf( "webfile oversize allocated=%d index=%d\n",
			allocated3 ? 1 : 0, (int)index );
		check( "oversize_chunk_refused", !allocated3 && index == -1 );
	}

	delete stream;
	delete scene;
	delete renderFile;
	manager.Destroy();
	Scheduler::Shutdown();

	const Sys::C_WebFileSystem::Counters& counters =
		Sys::C_WebFileSystem::GetCounters();
	printf( "webfile counters openAttempts=%llu openSucceeded=%llu "
		"writeOpenRefused=%llu unmountedOpenRefused=%llu bufferHintRefused=%llu "
		"reads=%llu readBytes=%llu readFailures=%llu closes=%llu exists=%llu "
		"fileInfo=%llu unsupportedCalls=%llu abiMismatch=%llu\n",
		(unsigned long long)counters.openAttempts,
		(unsigned long long)counters.openSucceeded,
		(unsigned long long)counters.writeOpenRefused,
		(unsigned long long)counters.unmountedOpenRefused,
		(unsigned long long)counters.bufferHintRefused,
		(unsigned long long)counters.reads,
		(unsigned long long)counters.readBytes,
		(unsigned long long)counters.readFailures,
		(unsigned long long)counters.closes,
		(unsigned long long)counters.exists,
		(unsigned long long)counters.fileInfo,
		(unsigned long long)counters.unsupportedCalls,
		(unsigned long long)counters.abiMismatch );

	printf( "webfile render hash=0x%016llx bytes=%llu\n",
		(unsigned long long)render.hash, (unsigned long long)render.bytes );
	printf( "webfile physics hash=0x%016llx bytes=%llu\n",
		(unsigned long long)physics.hash, (unsigned long long)physics.bytes );
	printf( "webfile scene report tablehash=0x%016llx gpu=%d refused=%d perf=%d "
		"unsupported=%d\n", (unsigned long long)tableHash, report.gpuCalls,
		report.gpuCallsRefused, report.perfEvents, report.unsupportedCalls );
	printf( "webfile done checks=%d failures=%d\n", gChecks, gFailures );
	return gFailures == 0 ? 0 : 1;
}
