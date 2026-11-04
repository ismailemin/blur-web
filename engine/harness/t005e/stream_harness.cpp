// T-005e level-streaming harness.
//
// Mounts the installed level files through the engine file layer
// (Sys::C_WebFileSystem -> Sys::C_WebFile -> platform/file -> JS source) and,
// above it, the engine's overlay file system (LogicalFs::C_OverlayFs), then
// loads real Level.levelstream chunks through the engine's own streamer
// (RenderingData::Target::StreamManager::LoadChunk/GetChunkData) into its 4 MiB
// ChunkAllocator.
//
// The Scene/ChunkInfo table is NOT parsed here: that needs the target
// renderingdata archive, whose headers require the DX11 Display2/FX stack (see
// docs/work/analysis/engine-level-stream.md). The table is supplied by the
// committed probes/range-file reader, and engine/verify_stream.py checks it
// field by field against probes/asset-reader's level_inspect --index. What this
// harness proves is the streaming layer: every chunk range is read through
// Sys::I_File into the engine allocator and hashed, and a missing range fails.
//
// CLI:
//   node stream_harness.js <levelrender> <levelstream> <levelphysics> <chunks.tsv>
//
// chunks.tsv: one "index offset storedBytes logicalBytes" record per line,
// '#' comments allowed.

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

#include <system/scheduler.h>

#include <system/debug/log/GlobalInterface.h>
#include <system/debug/log/DebugLog.h>
#include <system/debug/Variables.h>

#include <OverlayFs/OverlayFs.h>
#include <OverlayFs/OverlayLayer.h>

#include <renderingdata/target.h>
#include <renderingdata/streaming.h>

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

struct ChunkRecord
{
	S32 index;
	U64 offset;
	U64 storedBytes;
	U64 logicalBytes;
};

bool read_manifest( const char* path, std::vector<ChunkRecord>* records )
{
	FILE* f = fopen( path, "rb" );
	if ( !f )
		return false;

	char line[ 512 ];
	while ( fgets( line, sizeof( line ), f ) )
	{
		if ( line[ 0 ] == '#' || line[ 0 ] == '\n' || line[ 0 ] == '\r' )
			continue;
		ChunkRecord r;
		unsigned index = 0;
		unsigned long long offset = 0, stored = 0, logical = 0;
		if ( sscanf( line, "%u %llu %llu %llu", &index, &offset, &stored, &logical ) != 4 )
		{
			fclose( f );
			return false;
		}
		r.index = (S32)index;
		r.offset = (U64)offset;
		r.storedBytes = (U64)stored;
		r.logicalBytes = (U64)logical;
		records->push_back( r );
	}
	fclose( f );
	return true;
}

// The engine streamer, one chunk at a time. On web LoadChunk performs the read
// in the same context and queues the completion (see the PLATFORM_WEB branch in
// renderingdata/source/noninterface/target/streammanager.cpp); GetChunkData is
// then the only way to observe it, exactly as on PC.
bool stream_one_chunk( RenderingData::Target::StreamManager& manager, Sys::I_File* file,
	const ChunkRecord& record, uint64_t* hashOut )
{
	if ( !manager.LoadChunk( record.index, file, record.offset, record.storedBytes ) )
		return false;

	S32 index = -1;
	bool loadFailed = true;
	RenderingData::Target::StreamManager::AutoChunkPointer data =
		manager.GetChunkData( index, loadFailed );

	if ( index != record.index || data == 0 || loadFailed )
		return false;

	if ( hashOut )
	{
		*hashOut = fnv_begin();
		fnv_bytes( *hashOut, &*data, (size_t)record.storedBytes );
	}
	return true;
}

} // namespace

int main( int argc, char** argv )
{
	if ( argc < 5 )
	{
		printf( "usage: node stream_harness.js <levelrender> <levelstream> "
			"<levelphysics> <chunks.tsv>\n" );
		return 2;
	}

	printf( "webfile abi=%u expected=%u\n", (unsigned)pf_abi_version(),
		(unsigned)PF_ABI_VERSION );
	check( "abi_version", pf_abi_version() == PF_ABI_VERSION );

	Sys::C_WebFileSystem filesystem;
	const char* const renderPath = "/levels/usa_la_river/Level.levelrender";
	const char* const streamPath = "/levels/usa_la_river/Level.levelstream";
	const char* const physicsPath = "/levels/usa_la_river/Level.levelphysics";

	const bool mountRender =
		filesystem.Mount( Sys::C_FilePath( renderPath ), "blob:levelrender" );
	const bool mountStream =
		filesystem.Mount( Sys::C_FilePath( streamPath ), "blob:levelstream" );
	const bool mountPhysics =
		filesystem.Mount( Sys::C_FilePath( physicsPath ), "blob:levelphysics" );
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

	check( "exists_render", overlay.FileExists( Sys::C_FilePath( renderPath ) ) );
	check( "exists_stream", overlay.FileExists( Sys::C_FilePath( streamPath ) ) );
	check( "exists_physics", overlay.FileExists( Sys::C_FilePath( physicsPath ) ) );

	// The three files through the engine overlay. Levelrender and levelphysics
	// are indexed/checked by the committed probes; here they prove the engine
	// file path reaches the same bytes.
	const FileHash render = hash_file( overlay, renderPath, 16 * 1024 );
	const FileHash physics = hash_file( overlay, physicsPath, 16 * 1024 );
	check( "render_read", render.ok && render.bytes > 0 );
	check( "physics_read", physics.ok && physics.bytes > 0 );

	// The streamer asks for m_BufferSizeHint == 0 (StreamData::OpenStreamFile,
	// streamdata.cpp:143-147). C_WebFileSystem refuses 0 by its own documented
	// contract (only 1..1 MiB is accepted), so this spike opens the stream file
	// with the 16 KiB default. The range-read contract below is unchanged; the
	// hint refusal is recorded as a blocker in the analysis. Do not paper over
	// it here: a real StreamData wiring must resolve it in the file layer or at
	// the call site.
	Sys::I_File* stream = overlay.Open( Sys::C_FilePath( streamPath ),
		Sys::E_FileAccess_Read, Sys::C_OpenParams( 16 * 1024 ) );
	printf( "webfile open stream ok=%d length=%llu\n", stream ? 1 : 0,
		stream ? (unsigned long long)stream->Length() : 0ull );
	check( "stream_open", stream != 0 );
	if ( !stream )
	{
		printf( "webfile done checks=%d failures=%d\n", gChecks, gFailures );
		return 1;
	}

	std::vector<ChunkRecord> records;
	const bool manifestOk = read_manifest( argv[ 4 ], &records );
	printf( "webfile manifest records=%u ok=%d\n", (unsigned)records.size(),
		manifestOk ? 1 : 0 );
	check( "manifest", manifestOk && !records.empty() );
	if ( !manifestOk || records.empty() )
	{
		delete stream;
		printf( "webfile done checks=%d failures=%d\n", gChecks, gFailures );
		return 1;
	}

	// --- scheduler + engine streamer ---------------------------------------
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
	for ( size_t i = 0; i < records.size(); ++i )
	{
		uint64_t hash = 0;
		const bool ok = stream_one_chunk( manager, stream, records[ i ], &hash );
		if ( !ok )
		{
			++readFailures;
			printf( "webfile chunk %d FAILED offset=%llu bytes=%llu\n",
				records[ i ].index, (unsigned long long)records[ i ].offset,
				(unsigned long long)records[ i ].storedBytes );
			continue;
		}
		totalBytes += records[ i ].storedBytes;
		largest = std::max<U64>( largest, records[ i ].storedBytes );
		printf( "webfile chunk %d offset=%llu bytes=%llu hash=0x%016llx\n",
			records[ i ].index, (unsigned long long)records[ i ].offset,
			(unsigned long long)records[ i ].storedBytes, (unsigned long long)hash );
		if ( hash == 0 )
			++hashFailures;
	}

	printf( "webfile stream summary chunks=%u bytes=%llu largest=%llu "
		"readFailures=%u hashFailures=%u\n",
		(unsigned)records.size(), (unsigned long long)totalBytes,
		(unsigned long long)largest, readFailures, hashFailures );
	check( "stream_chunk_count", records.size() == 359 );
	check( "stream_all_read", readFailures == 0 );
	check( "stream_bytes", totalBytes == stream->Length() );
	check( "stream_largest", largest <= (U64)manager.MaxChunkSize() );
	check( "stream_no_requests", manager.GetNumRequests() == 0 );

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
	printf( "webfile done checks=%d failures=%d\n", gChecks, gFailures );
	return gFailures == 0 ? 0 : 1;
}
