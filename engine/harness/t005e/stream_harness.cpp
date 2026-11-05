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
