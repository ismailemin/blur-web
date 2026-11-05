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

/* ---------------------------------------------------------------------------
 * P27: CPU-side import of the target scene's resources and render lists.
 *
 * The archive deserialisers in archive.cpp run with no device. Instead of
 * creating a vertex/index buffer or a render state they record the archive
 * descriptor here. Nothing in this section interprets geometry: an entry says
 * what the file declared and which bytes it occupied.
 *
 * Bounds are fixed so an unexpected file cannot grow the module's static
 * memory; exceeding one is a fail-loud Unsupported(), not a truncation.
 * ------------------------------------------------------------------------- */
const int kMaxDeclarations = 256;
const int kMaxDeclElements = 32;
const int kMaxBuffers = 1024;
const int kMaxPrimitives = 2048;
const int kMaxLods = 8;
const int kMaxStreams = 16;
const int kArenaBytes = 8 * 1024 * 1024;

struct DeclElementRecord
{
	int stream;
	int offset;
	int type;
	int method;
	int usage;
	int usageIndex;
};

struct DeclRecord
{
	int count;
	DeclElementRecord elements[ kMaxDeclElements ];
};

/* kind: 0 = vertex buffer, 1 = index buffer. The record is what
 * CreateVertexBuffer/CreateIndexBuffer would have been asked for, plus the
 * serialised blob header. payload (when non-null) points into the arena. */
struct BufferRecord
{
	int kind;
	int count;        /* vertices or indices */
	int stride;       /* vertex stride, or index width in bytes */
	int bytes;        /* declared byte size */
	int alignment;    /* blob alignment */
	int compression;  /* Arch::CompressionType; 0 = none */
	int endianSwap;
	int payloadRetained;
	int payloadOffset; /* arena offset, -1 when not retained */
	unsigned long long streamOffset; /* archive offset of the blob header */
};

struct LodRecord
{
	int offset;
	int indices;
	int minIndex;
	int vertices;
};

struct StreamRecord
{
	int vertexBuffer;
	int streamIndex;
	int vertexOffset;
	int frequency;
	int materialIndex;
	int materialList;
};

/* One serialised RenderListNode::Primitive. streamOffset is the archive byte
 * position of its first field, so a caller can name the exact source record. */
struct PrimitiveRecord
{
	int streamOffset;
	int effect;
	int declaration;
	int topology;
	int indexBuffer;
	int flags;
	int baseMaterialIndex;
	int baseMaterialList;
	int instanceMaterialIndex;
	int instanceMaterialList;
	int lodCount;
	LodRecord lods[ kMaxLods ];
	int blendSrc;
	int blendDest;
	int blendOp;
	int alphaRef;
	int alphaToMask;
	int alphaTest;
	int blendEnable; /* serialised BlendState::AlphaBlendEnable, 0/1 */
	int cullMode;
	int streamCount;
	StreamRecord streams[ kMaxStreams ];
};

struct DrawListState
{
	/* Scene declarations (read once, index == serialised declaration id). */
	int declarations;
	DeclRecord decl[ kMaxDeclarations ];

	/* Records appended while a chunk/resource block is deserialised. */
	int vertexBuffers;
	int indexBuffers;
	BufferRecord vertexBuffer[ kMaxBuffers ];
	BufferRecord indexBuffer[ kMaxBuffers ];
	int primitives;
	PrimitiveRecord primitive[ kMaxPrimitives ];

	void* arena;
	int arenaUsed;
	int arenaCapacity;

	/* Accounting. Every counter is printed by the harness and asserted by
	 * engine/verify_stream.py. */
	int bufferOverflow;
	int primitiveOverflow;
	int lodOverflow;
	int streamOverflow;
	int declarationOverflow;
	int arenaExhausted;
	int compressedBuffers;
	int resourceLods;
	int resourceNodes;
	int resourceTextures;
	int textureLods;
	unsigned long long texturePayloadBytes;
	int texturesDiscarded;
	int gpuObjectsCreated;   /* must stay 0 */
};

DrawListState& Draws();

/* Destination for a blob payload. Returns 0 when the payload is not retained
 * (arena full); the record then reports payloadRetained = 0, never truncated
 * bytes. */
unsigned char* RetainBytes( int bytes, int* arenaOffset );

/* Append a declaration / buffer / primitive record. Returns 0 when the fixed
 * bound is exceeded; the caller turns that into a fail-loud Unsupported(). */
DeclRecord* AddDeclaration( int elementCount );
struct BufferRecord;
BufferRecord* AddBuffer( int kind, int count, int stride, int bytes );
PrimitiveRecord* AddPrimitive();

/* Clear the per-chunk records (buffers, primitives, arena) but keep the Scene
 * declaration table, which was read before any resource block. */
void ResetChunkRecords();
void ResetDrawList();

/* P27: registers the target RenderListNode factory/streamers. Defined in
 * target/archive.cpp at global scope; called from ActivateHandlers2. */
void RegisterRenderListHandlers();

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
