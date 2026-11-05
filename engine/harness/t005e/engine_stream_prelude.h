/* engine_stream_prelude.h - T-005e archive/streamer spike prelude.
 *
 * NOT engine code. Force-included (-include) before every TU of the T-005e
 * wasm32 build. It carries only:
 *
 *   1. the two CRT spellings the newly compiled renderer-side TUs use
 *      (stricmp), mapped to the C99 name emscripten provides;
 *   2. PERF_EVENT, which the engine defines in system/perf/PerfEvent.h only
 *      through platform profiler hooks. On web the marker is counted and
 *      otherwise does nothing - it is instrumentation, never a data path;
 *   3. the fail-loud boundary used by the patched archive.cpp / streamdata.cpp
 *      web branches, and the counters those branches record.
 *
 * The counters are evidence, not a parser: the harness prints them and
 * engine/verify_stream.py asserts on them (e.g. gpuCalls must stay 0 while the
 * Scene archive is walked).
 */
#ifndef BLUR_T005E_ENGINE_STREAM_PRELUDE_H
#define BLUR_T005E_ENGINE_STREAM_PRELUDE_H

#if !defined(__EMSCRIPTEN__)
#error "engine_stream_prelude.h is only valid for an emscripten build"
#endif

#include <stddef.h>
#include <stdint.h>
#include <strings.h>

#ifndef stricmp
#define stricmp strcasecmp
#endif

namespace Arch { template <typename EndianSwitch> class BinaryInputArchive_t; class BinaryInputArchive; }
namespace Ut { struct NoEndianSwap; struct DoEndianSwap; }
namespace RenderingData { namespace Target { class Scene; } }

namespace WebSpike
{

/* Counters written by the web branches inside the engine archive/streamer
 * TUs, and by the harness while it drives them. */
struct SceneReport
{
	/* Scene archive (RenderingData::Target::Scene) */
	int targetSceneVersion;
	int vertexDeclarations;
	int vertexDeclarationElements;
	int effects;
	int sharedTextures;
	unsigned long long sharedTextureBytes;
	int resourceBlockCount;
	int initiallyLoadedBlocks;

	/* StreamData / ChunkInfo */
	int streamVersion;
	int streamChunks;
	int streamItems;
	int streamPrerequisites;
	int streamDependants;
	int chunksDisabledOverChunkAllocator;
	unsigned long long streamStoredBytes;
	unsigned long long streamOriginalBytes;

	/* Bytes the Scene archive walk consumed, relative to the Scene body. */
	unsigned long long sceneBytesRead;

	/* StreamData::OpenStreamFile / CacheChunk */
	int streamFileOpened;
	int streamFileBufferHint;
	int cacheChunkRequests;
	int cacheChunkRefused;
	int cacheChunkPrerequisiteBlocked;

	/* Fail-loud accounting. */
	int gpuCalls;
	int gpuCallsRefused;
	int perfEvents;
	int unsupportedCalls;
	int renderListHandlerRegistered;
};

SceneReport& Report();

/* A renderer entry point was reached on a target with no device. Prints the
 * API, source file and line to stderr and aborts; it never returns. */
void GpuCallAbort( const char* api, const char* file, int line );

/* An engine path that is deliberately not ported (e.g. the streaming request
 * scheduler tasks). Same contract as GpuCallAbort. */
void Unsupported( const char* what, const char* file, int line );

/* A bounded archive read ran past its declared size or the file end. */
void ArchiveUnderflow( const char* file, int line, unsigned long long wanted,
	unsigned long long available );

void PerfEvent( const char* name );

/* Engine archive entry points (archive.cpp, PLATFORM_WEB only). Declared with
 * forward declarations so the prelude needs no engine header. */
void ParseSceneArchive( ::Arch::BinaryInputArchive& ar,
	::RenderingData::Target::Scene& scene );

}

#if !defined(PERF_EVENT)
#define PERF_EVENT( name ) ::WebSpike::PerfEvent( name )
#endif

/* RESOURCE_MEMORY_ID is graphics/display/include/Display/memory/MemoryTracker.h.
 * It exists only in a build with the display memory tracker, and there is no
 * display here. It labels allocator scopes; it never carries data. */
#if !defined(RESOURCE_MEMORY_ID)
#define RESOURCE_MEMORY_ID( name ) ( (void)0 )
#endif

#define WEBSPIKE_GPU_REFUSED( api ) \
	::WebSpike::GpuCallAbort( ( api ), __FILE__, __LINE__ )
#define WEBSPIKE_UNSUPPORTED( what ) \
	::WebSpike::Unsupported( ( what ), __FILE__, __LINE__ )

#endif /* BLUR_T005E_ENGINE_STREAM_PRELUDE_H */
