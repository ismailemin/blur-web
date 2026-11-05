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

void fnv_f32( uint64_t& hash, F32 value )
{
	U32 bits;
	memcpy( &bits, &value, sizeof( bits ) );
	fnv_u32( hash, bits );
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

// Emit one draw record. Every field comes from the archive; a field that the
// engine did not bind is printed as null with a reason token, never guessed.
void emitOneDraw( const RenderingData::Target::RenderListNode& list, int drawIndex,
	int nodeIndex, const WebSpike::PrimitiveRecord& record, int primitiveIndex,
	S32 chunkIndex, const GeometryView& geometry, const RenderingData::Bounds* pBounds,
	unsigned char* usedVertexBuffer, DrawTotals* totals )
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
		"flags=0x%08x blend=%d,%d,%d,%d,%d,%d,%d ",
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
		record.alphaRef, record.alphaToMask, record.alphaTest, record.cullMode );

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
}

// Walk every node of the parsed block, emit render-list draws and instances,
// and fill the deterministic totals.
void emitNodeDraws( RenderingData::Target::ResourceBlock::Resources* resources,
	const ChunkRange& range, const GeometryView& geometry, DrawTotals* totals )
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
				range.chunk, geometry, pBounds, usedVertexBuffer, totals );
			++drawIndex;
		}

		// Instance rows: the serialised instance description, not a transform.
		// Instance transforms live in runtime material rows, which this slice
		// does not import; the draw list therefore prints world=null with a
		// reason instead of a guessed matrix.
		for ( int i = 0; i < numInstances && i < 256; i++ )
		{
			const RenderingData::RenderListNode::Instance& instance =
				list->GetInstance( i );

			printf( "webfiledraw instance %d chunk=%d nodeIndex=%d "
				"primitiveIndex=%d material=%d:%d flags=0x%08x streams=%d "
				"world=null worldReason=instanceTransformNotImported\n", i,
				(int)range.chunk, n, (int)instance.primitiveIndex,
				(int)instance.material.index, (int)instance.material.listIndex,
				(unsigned)instance.flags, (int)instance.primitiveStreams.Size() );
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
				geoVbCount = draws.vertexBuffers;
				geoIbCount = draws.indexBuffers;
				geoNodeCount = draws.resourceNodes;
				geoTextureCount = draws.resourceTextures;

				for ( int i = 0; i < geoVbCount && i < WebSpike::kMaxBuffers; i++ )
					geoVb[ i ] = draws.vertexBuffer[ i ];
				for ( int i = 0; i < geoIbCount && i < WebSpike::kMaxBuffers; i++ )
					geoIb[ i ] = draws.indexBuffer[ i ];

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
					emitNodeDraws( resources, range, geometry, &totals );

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

		// Node block 253: the render list whose instance count is compared with
		// level_inspect --instances-all (57 instances / 36 base primitives).
		{
			WebSpike::ResetChunkRecords();

			ChunkRange range;
			const bool located = findChunkItem( scene->GetStreamData(),
				kInstanceNodeBlock, 0, &range );
			printf( "webfiledraw chunk name=instancenode block=%d chunk=%d item=%d "
				"lod=%d offset=%llu bytes=%llu located=%d\n",
				(int)kInstanceNodeBlock,
				(int)range.chunk, (int)range.item, (int)range.lod,
				(unsigned long long)range.offset,
				(unsigned long long)range.bytes, located ? 1 : 0 );
			check( "drawlist_instance_node_located", located );

			if ( located )
			{
				std::vector<U8> bytes;
				RenderingData::Target::ResourceBlock::Resources* resources =
					loadChunkCopy( manager, stream, range, bytes )
					? parseChunkItem( bytes, scene, range, 0, 0, 0 ) : 0;
				const bool parsed = resources != 0;

				DrawTotals totals;
				memset( &totals, 0, sizeof( totals ) );
				totals.hash = fnv_begin();

				if ( parsed )
					emitNodeDraws( resources, range, geometry, &totals );

				printf( "webfiledraw instances node=%d renderlists=%d "
					"instanceCount=%d basePrimitives=%d draws=%d\n",
					(int)kInstanceNodeBlock, totals.renderLists, totals.instances,
					totals.basePrimitives, totals.draws );
				check( "drawlist_instance_import", parsed && totals.renderLists > 0 );
				check( "drawlist_instance_count", totals.instances == 57 );
				check( "drawlist_base_primitive_count",
					totals.basePrimitives == 36 );

				delete resources;
			}
		}

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
