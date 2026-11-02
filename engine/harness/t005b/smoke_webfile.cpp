// T-005b file-layer harness.
//
// Opens the real installed cache/root.pak through the ENGINE file layer
// (Sys::C_WebFileSystem -> Sys::C_WebFile -> platform/file -> JS range source)
// and proves that the bytes delivered are the file's bytes:
//
//   1. the PAK metadata index parsed over the engine stream is identical to
//      probes/range-file's `range_probe pak` output (compared by
//      engine/verify_file_overlay.py);
//   2. the whole 533 MiB file hashed through the engine stream equals an
//      independent FNV-1a 64 computed by Python over the same file;
//   3. the two Underflow paths (direct read into the caller's buffer, and the
//      resident-buffer refill) produce the same index and the same hash;
//   4. every explicit failure is explicit: a read at end of file, an oversized
//      range at the C ABI, a range past the end, a zero-length range, a write
//      handle, an unmounted path and a source with no synchronous store.
//
// This is the file layer only. No PAK payload is decoded, no level is opened,
// and no renderer, audio or game code is involved.

#include <stdio.h>
#include <string.h>

#include <algorithm>
#include <stdexcept>
#include <string>
#include <vector>

#include <system/serialise/C_WebFile.h>
#include <system/serialise/PlatformFileWeb.h>
#include <system/serialise/FileSystemGlobals.h>

#include <system/scheduler.h>

#include <system/debug/log/GlobalInterface.h>
#include <system/debug/log/DebugLog.h>

#include <PakFs/Pak.h>
#include <PakFs/PakGlobals.h>
#include <PakFs/Impl/PakEntryFile.h>
#include <PakFs/Impl/PakFatEntry.h>
#include <PakFs/Impl/PakFile.h>
#include <PakFs/Impl/PakIoMediator.h>
#include <PakFs/Impl/PakUtil.h>

#include "pak_index_range.h"

namespace
{

const char* const kMountPrefix = "/cache/root.pak";
const char* const kSourceId = "blob:root.pak";
const char* const kAsyncOnlyPrefix = "/async/only.bin";
const char* const kAsyncOnlySource = "http:async-only";

int gChecks = 0;
int gFailures = 0;

void check( const char* name, bool pass )
{
	++gChecks;
	if ( !pass )
		++gFailures;
	printf( "webfile check %s pass=%d\n", name, pass ? 1 : 0 );
}

// A ByteSource over Sys::I_File. This is the exact adapter shape the design
// requires (t005-streaming-design.md 7.2): the engine's random-access file
// contract underneath the probe's bounded range reader. It validates ranges
// itself so a bad offset fails here instead of inside the parser.
class EngineByteSource : public rangefile::ByteSource
{
public:
	EngineByteSource( Sys::I_File* file, uint64_t size )
		: m_file( file ), m_size( size ) {}

	uint64_t size() const override { return m_size; }
	const char* kind() const override { return "engine-I_File"; }

	void read( uint64_t offset, uint8_t* destination, size_t length ) override
	{
		if ( !destination && length )
			throw std::runtime_error( "null read destination" );
		if ( offset > m_size || uint64_t( length ) > m_size - offset )
		{
			throw std::runtime_error( "range outside the file: offset " + std::to_string( offset ) +
				" length " + std::to_string( uint64_t( length ) ) +
				" size " + std::to_string( m_size ) );
		}

		m_file->SetPosition( offset );
		if ( !m_file->Read( destination, (U32)length ) )
		{
			throw std::runtime_error( "engine read failed at offset " + std::to_string( offset ) +
				" length " + std::to_string( uint64_t( length ) ) );
		}
	}

private:
	Sys::I_File* m_file;
	uint64_t m_size;
};

bool read_index( Sys::I_File* file, size_t window, std::string* json, rangefile::RangeStats* stats )
{
	try
	{
		EngineByteSource source( file, file->Length() );
		rangefile::RangeFile range( source, window );
		const rangefile::PakIndex index = rangefile::parse_pak_index( range );
		*stats = range.stats();
		*json = rangefile::pak_index_json( index, range.stats() );
		return true;
	}
	catch ( const std::exception& error )
	{
		printf( "webfile error index: %s\n", error.what() );
		return false;
	}
}

struct HashResult
{
	uint64_t hash;
	uint64_t bytes;
	uint32_t calls;
	bool ok;
};

// FNV-1a 64 over the whole file, read through the engine stream in `chunk`
// sized reads. `chunk` relative to the buffer hint chooses the Underflow path.
HashResult hash_file( Sys::I_File* file, size_t chunk )
{
	HashResult result = { 0xcbf29ce484222325ull, 0, 0, false };
	const uint64_t length = file->Length();
	std::vector<uint8_t> buffer( chunk );
	file->SetPosition( 0 );

	while ( result.bytes < length )
	{
		const uint32_t want =
			(uint32_t)std::min<uint64_t>( (uint64_t)chunk, length - result.bytes );
		if ( !file->Read( &buffer[0], want ) )
		{
			printf( "webfile error hash: read failed at offset %llu\n",
				(unsigned long long)result.bytes );
			return result;
		}
		++result.calls;
		for ( uint32_t i = 0; i < want; ++i )
		{
			result.hash ^= buffer[i];
			result.hash *= 0x100000001b3ull;
		}
		result.bytes += want;
	}

	result.ok = ( result.bytes == length );
	return result;
}

void print_stats( const char* label, const rangefile::RangeStats& stats )
{
	printf( "webfile index %s requests=%llu bytes=%llu largest=%llu window=%llu fullFileBytesCopied=%llu\n",
		label,
		(unsigned long long)stats.sourceRequests,
		(unsigned long long)stats.bytesRead,
		(unsigned long long)stats.largestSourceRequest,
		(unsigned long long)stats.windowBytes,
		(unsigned long long)stats.fullFileBytesCopied );
}

} // namespace

// ---------------------------------------------------------------- consumer --
// The engine's own PAK reader over the file layer. Nothing here reimplements the
// format: Pak::ReadPak reads the pre-header, the v2 header, the string table and
// the FAT through C_PakIoMediator (a client of Sys::I_File), and C_PakEntryFile
// drives Pak::C_PakCompressPacketZLib (codec 4) for the payload.

// g_SystemIoLog is defined by system/source/serialise/C_FileSystem.cpp:39, and
// C_FileSystem.cpp is not part of a web build (it is the Win32 file system the
// design bypasses). PakEntryFile.cpp only uses it as the FSPERF/FSASSERT
// logger, so the harness supplies the same definition: the same logger name the
// engine uses, nothing else. External linkage on purpose - it satisfies
// PakEntryFile.o's extern.
Debug::Logger& g_SystemIoLog = Debug::GetLogger( "mercury.system.io" );

namespace
{

// The two fixture entries are looked up by their FAT path, which is what the
// reference index lists. Both are small enough to hash in full and together
// cover a single-packet and a three-packet stream (the last packet is partial).
struct EntryFixture
{
	const char* path;
};
const EntryFixture kEntryFixtures[] = {
	{ "\\animations\\cameras\\start_3_frontcamera.cycle" },
	{ "\\graphics\\textures\\postprocess\\la_river_02_lut.dds" },
};
const int kEntryFixtureCount = 2;

// piStreamer, verbatim from SchedulerConfig.cpp:49-50. The PAK codec runs its
// inflate work as scheduler tasks, so it needs a policy, and it creates one
// group per open entry file - after SetGroupPoolSize, as the game does.
const Scheduler::Policy kPakStreamerPolicy[8] = { 0, 0, 7, 7, 7, 7, 7, 7 };

const uint32_t kPakGroupPool = 64;

struct EntryReadResult
{
	uint64_t length;
	uint64_t hash;
	uint32_t reads;
	bool ok;
};

bool read_entry( Pak::C_PakFile* pak, Pak::C_PakFatEntry* fatEntry, const char* path,
	U32 bufferHint, EntryReadResult* out )
{
	out->length = 0;
	out->hash = 0xcbf29ce484222325ull;
	out->reads = 0;
	out->ok = false;

	// This is exactly what LogicalFs::C_PakFs::Open does for a read handle
	// (PakFs.cpp:99-137), without the I_FileSystem wrapper: C_PakFs cannot be
	// linked here because its DirectoryInfo implements C_DirectoryInfo, whose
	// code lives in C_FileSystem.cpp - a TU the design keeps out of the web
	// build (t005-streaming-design.md 1.2).
	Pak::C_PakEntryFile file;
	if ( !file.Open( pak, fatEntry, Sys::C_FilePath( path ), Sys::E_FileAccess_Read,
		Sys::C_OpenParams( bufferHint ), NULL ) )
	{
		return false;
	}

	const uint64_t length = file.Length();
	std::vector<U8> buffer( 64 * 1024 );
	uint64_t total = 0;
	while ( total < length )
	{
		const U32 want = (U32)std::min<uint64_t>( (uint64_t)buffer.size(), length - total );
		if ( !file.Read( &buffer[0], want ) )
			break;
		for ( U32 i = 0; i < want; ++i )
		{
			out->hash ^= buffer[i];
			out->hash *= 0x100000001b3ull;
		}
		total += want;
		++out->reads;
	}

	out->length = length;
	out->ok = ( total == length );
	return out->ok;
}

// One line per FAT record, in the field order the reference index uses. The
// verify script compares these against probes/range-file's records.
void dump_fat( Pak::C_PakFile* pak )
{
	const U32 stride = Pak::GetFatEntrySize( (Pak::E_FatEntryType)pak->header.fatEntryType );
	printf( "webfile pakheader version=%u sector=%u codec=%u fat=%u entries=%u strings=%u stride=%u\n",
		(unsigned)pak->version, (unsigned)pak->pMediator->GetSectorSize(),
		(unsigned)pak->header.codec, (unsigned)pak->header.fatEntryType,
		(unsigned)pak->nFatEntries, (unsigned)pak->stringTable.dataSize, (unsigned)stride );

	for ( U32 i = 0; i < pak->nFatEntries; ++i )
	{
		Pak::C_PakFatEntry* entry = pak->GetFatEntryByIdx( i );
		const char* path = (const char*)( pak->stringTable.pData + entry->filePathStrTableOffset );

		// "-" is what the reference index prints for a null field: a directory
		// has no payload offset and no stored size, and a root entry has no
		// parent. Keeping the same spelling makes the comparison exact.
		char offsetText[32];
		char physicalText[32];
		char parentText[32];
		if ( entry->IsDirectory() )
		{
			snprintf( offsetText, sizeof( offsetText ), "-" );
			snprintf( physicalText, sizeof( physicalText ), "-" );
		}
		else
		{
			snprintf( offsetText, sizeof( offsetText ), "%llu",
				(unsigned long long)( entry->dataStartSector *
					(U64)pak->pMediator->GetSectorSize() ) );
			snprintf( physicalText, sizeof( physicalText ), "%llu",
				(unsigned long long)( pak->pStoredSizes ? (U64)pak->pStoredSizes[ i ] : 0 ) );
		}
		if ( entry->parentDirectoryOffsetBytes == 0xFFFFFFFFu )
			snprintf( parentText, sizeof( parentText ), "-" );
		else
			snprintf( parentText, sizeof( parentText ), "%u",
				(unsigned)( entry->parentDirectoryOffsetBytes / stride ) );

		printf( "webfile pakentry %u|%u|%u|%s|%s|%s|%d|%s\n",
			(unsigned)i, (unsigned)entry->filePathCrc,
			(unsigned)entry->dataLogicalLengthBytes,
			physicalText, offsetText, parentText,
			entry->IsDirectory() ? 1 : 0, path );
	}
}

} // namespace


int main( int argc, char** argv )
{
	(void)argc;
	(void)argv;

	printf( "webfile abi=%u expected=%u\n", (unsigned)pf_abi_version(), (unsigned)PF_ABI_VERSION );
	check( "abi_version", pf_abi_version() == PF_ABI_VERSION );

	Sys::C_WebFileSystem filesystem;

	const bool mounted = filesystem.Mount( Sys::C_FilePath( kMountPrefix ), kSourceId );
	printf( "webfile mount prefix=%s source=%s ok=%d\n", kMountPrefix, kSourceId, mounted ? 1 : 0 );
	check( "mount", mounted );

	const bool asyncOnlyMounted =
		filesystem.Mount( Sys::C_FilePath( kAsyncOnlyPrefix ), kAsyncOnlySource );
	check( "mount_async_only", asyncOnlyMounted );

	Sys::SetDefaultFileSystem( &filesystem );

	// --- 1. open through the engine seam ------------------------------------
	const Sys::C_FilePath pakPath( kMountPrefix );
	Sys::I_File* pak = Sys::GetDefaultFileSystem()->Open( pakPath, Sys::E_FileAccess_Read );
	printf( "webfile open ok=%d\n", pak ? 1 : 0 );
	check( "open", pak != 0 );
	if ( pak == 0 )
	{
		printf( "webfile done checks=%d failures=%d\n", gChecks, gFailures );
		return 1;
	}

	const uint64_t size = pak->Length();
	printf( "webfile source length=%llu position=%llu\n",
		(unsigned long long)size, (unsigned long long)pak->GetPosition() );
	check( "length_nonzero", size > 0 );

	// --- 2. index over the engine stream, both Underflow paths --------------
	std::string jsonDirect;
	rangefile::RangeStats statsDirect;
	const bool directOk = read_index( pak, 64 * 1024, &jsonDirect, &statsDirect );
	check( "index_parse_direct", directOk );
	if ( directOk )
		print_stats( "direct", statsDirect );

	// A 16-byte buffer sends every parser read of 16 bytes or more down the
	// direct path; a 128 KiB buffer keeps every read in the resident buffer.
	Sys::I_File* pakDirect =
		Sys::GetDefaultFileSystem()->Open( pakPath, Sys::E_FileAccess_Read, Sys::C_OpenParams( 16 ) );
	Sys::I_File* pakBuffered =
		Sys::GetDefaultFileSystem()->Open( pakPath, Sys::E_FileAccess_Read, Sys::C_OpenParams( 128 * 1024 ) );
	check( "open_small_buffer", pakDirect != 0 );
	check( "open_large_buffer", pakBuffered != 0 );

	std::string jsonSmall;
	std::string jsonLarge;
	rangefile::RangeStats statsSmall;
	rangefile::RangeStats statsLarge;
	const bool smallOk = pakDirect && read_index( pakDirect, 64 * 1024, &jsonSmall, &statsSmall );
	const bool largeOk = pakBuffered && read_index( pakBuffered, 64 * 1024, &jsonLarge, &statsLarge );
	check( "index_parse_small_buffer", smallOk );
	check( "index_parse_large_buffer", largeOk );
	if ( smallOk )
		print_stats( "small_buffer", statsSmall );
	if ( largeOk )
		print_stats( "large_buffer", statsLarge );
	check( "index_paths_agree", smallOk && largeOk && jsonSmall == jsonLarge );
	check( "index_paths_agree_with_default", directOk && smallOk && jsonSmall == jsonDirect );

	if ( directOk )
	{
		printf( "---WEBFILE-PAK-JSON-BEGIN---\n" );
		printf( "%s\n", jsonDirect.c_str() );
		printf( "---WEBFILE-PAK-JSON-END---\n" );
		printf( "webfile json bytes=%llu\n", (unsigned long long)jsonDirect.size() );
	}

	// --- 3. whole-file hashes, direct and buffered --------------------------
	// Direct: 64 KiB reads with a 16 KiB buffer (every read takes the direct
	// path). Buffered: 4 KiB reads with a 128 KiB buffer (every read refills the
	// resident buffer).
	const HashResult direct = hash_file( pakDirect ? pakDirect : pak, 64 * 1024 );
	printf( "webfile fnv direct hash=0x%016llx bytes=%llu reads=%u ok=%d\n",
		(unsigned long long)direct.hash, (unsigned long long)direct.bytes,
		direct.calls, direct.ok ? 1 : 0 );
	check( "hash_direct", direct.ok && direct.bytes == size );

	const HashResult buffered = hash_file( pakBuffered ? pakBuffered : pak, 4 * 1024 );
	printf( "webfile fnv buffered hash=0x%016llx bytes=%llu reads=%u ok=%d\n",
		(unsigned long long)buffered.hash, (unsigned long long)buffered.bytes,
		buffered.calls, buffered.ok ? 1 : 0 );
	check( "hash_buffered", buffered.ok && buffered.bytes == size );
	check( "hash_paths_agree", direct.hash == buffered.hash );

	if ( pakDirect )
		delete pakDirect;
	if ( pakBuffered )
		delete pakBuffered;

	// --- 4. explicit failures ----------------------------------------------
	{
		// Engine-level read that crosses end of file. C_File's contract is to
		// deliver what exists and fail the read; the platform must never be asked
		// for a byte past the end.
		pak->SetPosition( size - 4 );
		uint8_t tail[16];
		const bool eofRead = pak->Read( tail, 16 );
		printf( "webfile eof read_returned=%d at=%llu\n", eofRead ? 1 : 0,
			(unsigned long long)( size - 4 ) );
		check( "eof_read_fails", !eofRead );
	}

	const uint32_t rawHandle = pf_open( kSourceId, PF_ACCESS_READ );
	printf( "webfile abi handle=%u size=%llu\n", (unsigned)rawHandle,
		(unsigned long long)pf_size( rawHandle ) );
	check( "abi_open", rawHandle != 0 );

	if ( rawHandle != 0 )
	{
		uint8_t scratch[64];

		const uint32_t crossing = pf_read_at( rawHandle, size - 4, scratch, 16 );
		printf( "webfile abi crossing_eof returned=%u\n", (unsigned)crossing );
		check( "abi_crossing_eof_rejected", crossing == 0 );

		const uint32_t past = pf_read_at( rawHandle, size, scratch, 1 );
		printf( "webfile abi past_eof returned=%u\n", (unsigned)past );
		check( "abi_past_eof_rejected", past == 0 );

		const uint32_t zero = pf_read_at( rawHandle, 0, scratch, 0 );
		printf( "webfile abi zero_length returned=%u\n", (unsigned)zero );
		check( "abi_zero_length_rejected", zero == 0 );

		const uint32_t whole = pf_read_at( rawHandle, 1, scratch, 0xFFFFFFFFu );
		printf( "webfile abi oversize returned=%u\n", (unsigned)whole );
		check( "abi_oversize_rejected", whole == 0 );

		const uint32_t wrote = pf_write_at( rawHandle, 0, scratch, 4 );
		printf( "webfile abi write returned=%u\n", (unsigned)wrote );
		check( "abi_write_refused", wrote == 0 );

		const int32_t enqueued =
			pf_enqueue_read( rawHandle, 0, 4, (uint32_t)(uintptr_t)scratch );
		printf( "webfile abi enqueue returned=%d\n", (int)enqueued );
		check( "abi_enqueue_refused", enqueued < 0 );

		pf_close( rawHandle );
	}

	check( "exists_mounted", pf_exists( kSourceId ) != 0 );
	check( "exists_unmounted", pf_exists( "blob:not-installed" ) == 0 );

	// A source without a synchronous store can be opened (its size is known) but
	// any I_File::Read must fail: nothing may fake the bytes.
	{
		Sys::I_File* asyncOnly =
			Sys::GetDefaultFileSystem()->Open( Sys::C_FilePath( kAsyncOnlyPrefix ), Sys::E_FileAccess_Read );
		uint8_t scratch[8];
		const bool readSucceeded = asyncOnly ? asyncOnly->Read( scratch, 8 ) : true;
		printf( "webfile async_only opened=%d read_returned=%d\n",
			asyncOnly ? 1 : 0, readSucceeded ? 1 : 0 );
		check( "async_only_read_fails", asyncOnly != 0 && !readSucceeded );
		if ( asyncOnly )
			delete asyncOnly;
	}

	// Unmounted path and write handle are refused by the file system, not by the
	// provider: they never reach the ABI.
	{
		Sys::I_File* unmounted =
			Sys::GetDefaultFileSystem()->Open( Sys::C_FilePath( "/nope/x.pak" ), Sys::E_FileAccess_Read );
		printf( "webfile unmounted open_returned=%d\n", unmounted ? 1 : 0 );
		check( "unmounted_open_refused", unmounted == 0 );
		if ( unmounted )
			delete unmounted;
	}
	{
		Sys::I_File* writeHandle =
			Sys::GetDefaultFileSystem()->Open( pakPath, Sys::E_FileAccess_Write );
		printf( "webfile write open_returned=%d\n", writeHandle ? 1 : 0 );
		check( "write_open_refused", writeHandle == 0 );
		if ( writeHandle )
			delete writeHandle;
	}

	// FileInfo/FileExists/DirectoryInfo are the rest of the I_FileSystem surface.
	{
		Sys::C_FileInfo info;
		info.Clear();
		const bool haveInfo = Sys::GetDefaultFileSystem()->FileInfo( pakPath, &info );
		printf( "webfile fileinfo ok=%d size=%llu type=%d\n", haveInfo ? 1 : 0,
			(unsigned long long)info.m_FileSize, (int)info.m_FileType );
		check( "fileinfo_size", haveInfo && uint64_t( info.m_FileSize ) == size );
		check( "fileinfo_type", haveInfo && info.m_FileType == Sys::E_FileType_File );
		check( "exists_via_filesystem",
			Sys::GetDefaultFileSystem()->FileExists( pakPath ) );
		// C_DirectoryInfo is C_FileSystem's type and is not linked here; the call
		// is refused before the pointer is touched, so null is safe and proves
		// the refusal.
		const bool haveDir = Sys::GetDefaultFileSystem()->DirectoryInfo( pakPath, 0 );
		check( "directory_info_refused", !haveDir );
	}

	delete pak;

	// --- 6. the engine PAK reader over the file layer ----------------------
	{
		// Initialisation order copied from C_SchedulerConfig::Initialise
		// (SchedulerConfig.cpp:34-62): policies, Init, Start, group pool, then
		// groups. The PAK codec creates its group when an entry file is opened.
		const Scheduler::PolicyHandle policy = Scheduler::CreatePolicy( kPakStreamerPolicy );
		printf( "webfile pak policy=%d\n", (int)policy );
		check( "pak_policy", policy >= 0 );
		Scheduler::Init();
		Scheduler::Start();
		Scheduler::SetGroupPoolSize( kPakGroupPool );
		Pak::SetPacketCompressionPolicy( (S32)policy );

		// Pak::ReadPak is the engine's PAK reader: pre-header, v2 header,
		// string table, FAT (v2 40-byte entries converted to the in-memory
		// C_PakFatEntry layout), all through C_PakIoMediator -> Sys::I_File ->
		// our C_WebFile. C_PakFs::OpenPak is a 20-line wrapper around exactly
		// this call; using it directly avoids C_PakFs::DirectoryInfo, whose
		// C_DirectoryInfo implementation lives in C_FileSystem.cpp - a TU the
		// design keeps out of the web build.
		const Sys::C_FilePath archive( kMountPrefix );
		Pak::C_PakFile* enginePak = Pak::ReadPak( *Sys::GetDefaultFileSystem(), archive,
			Sys::E_FileAccess_Read, NULL, Sys::C_OpenParams( 32 * 1024 ) );
		printf( "webfile pak open=%d\n", enginePak ? 1 : 0 );
		check( "pak_open", enginePak != 0 );

		if ( enginePak )
		{
			printf( "webfile pak entries=%u version=%u codec=%u fat=%u sector=%u\n",
				(unsigned)enginePak->nFatEntries, (unsigned)enginePak->version,
				(unsigned)enginePak->header.codec, (unsigned)enginePak->header.fatEntryType,
				(unsigned)enginePak->pMediator->GetSectorSize() );
			check( "pak_entries", enginePak->nFatEntries > 0 );
			dump_fat( enginePak );

			// Every fixture must be in the FAT, and must be readable.
			for ( int i = 0; i < kEntryFixtureCount; ++i )
			{
				const char* path = kEntryFixtures[ i ].path;
				Pak::C_PakFatEntry* fatEntry =
					enginePak->GetFatEntry( Sys::C_FilePath( path ) );
				printf( "webfile pak fat %s found=%d logical=%u stored=%u\n", path,
					fatEntry ? 1 : 0,
					fatEntry ? (unsigned)fatEntry->dataLogicalLengthBytes : 0u,
					( fatEntry && enginePak->pStoredSizes )
						? (unsigned)enginePak->pStoredSizes[ fatEntry -
							(Pak::C_PakFatEntry*)enginePak->pFatEntries ] : 0u );
				check( "pak_fat_lookup", fatEntry != 0 && !fatEntry->IsDirectory() );

				// Unbuffered (m_BufferSizeHint == 0) is the shape the streamer
				// uses for streamed chunks; buffered exercises the 32 KiB
				// refill path of C_PakEntryFile.
				EntryReadResult streamed;
				EntryReadResult buffered;
				const bool streamedOk = fatEntry && !fatEntry->IsDirectory() &&
					read_entry( enginePak, fatEntry, path, 0, &streamed );
				const bool bufferedOk = fatEntry && !fatEntry->IsDirectory() &&
					read_entry( enginePak, fatEntry, path, 32 * 1024, &buffered );
				printf( "webfile pak read %s streamed=%d bytes=%llu hash=0x%016llx reads=%u\n",
					path, streamedOk ? 1 : 0, (unsigned long long)streamed.length,
					(unsigned long long)streamed.hash, streamed.reads );
				printf( "webfile pak read %s buffered=%d bytes=%llu hash=0x%016llx reads=%u\n",
					path, bufferedOk ? 1 : 0, (unsigned long long)buffered.length,
					(unsigned long long)buffered.hash, buffered.reads );
				check( "pak_entry_read_streamed", streamedOk );
				check( "pak_entry_read_buffered", bufferedOk );
				check( "pak_entry_paths_agree",
					streamedOk && bufferedOk && streamed.hash == buffered.hash &&
					streamed.length == buffered.length );
				check( "pak_entry_length_matches_fat",
					fatEntry && streamed.length == fatEntry->dataLogicalLengthBytes );
			}
		}

		delete enginePak;
		Scheduler::Shutdown();
		printf( "webfile pak closed\n" );
	}

	// --- 5. bookkeeping ----------------------------------------------------
	const Sys::C_WebFileSystem::Counters& counters = Sys::C_WebFileSystem::GetCounters();
	printf( "webfile counters openAttempts=%llu openSucceeded=%llu writeOpenRefused=%llu "
		"unmountedOpenRefused=%llu bufferHintRefused=%llu reads=%llu readBytes=%llu "
		"readFailures=%llu closes=%llu exists=%llu fileInfo=%llu unsupportedCalls=%llu "
		"abiMismatch=%llu\n",
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

	printf( "webfile done checks=%d failures=%d\n", gChecks, gFailures );
	return gFailures == 0 ? 0 : 1;
}
