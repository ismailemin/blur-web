/* scene_target_web.cpp - data-only link shims for the T-005e archive spike.
 *
 * graphics/renderingdata/source/noninterface/target/render.cpp is the renderer's
 * scene module: FX::g_Manager, Display2 resource pointers, texture reload and
 * GlobalBindings. It is deliberately NOT compiled for wasm32. Four of its
 * definitions are needed by the archive path and none of them touch the
 * renderer, so they are reproduced here verbatim from the cited upstream lines,
 * plus two engine statics whose owning TUs are renderer modules.
 *
 * Nothing in this file interprets data; it is the equivalent of a platform
 * backend providing its own Scene/Effect constructors.
 */
#include "stdafx.h"
#include "renderingdata/target.h"
#include "renderingdata/streaming.h"
#include "btl/allocators/stackallocator.h"

#include "engine_stream_prelude.h"

namespace RenderingData
{
namespace Target
{

// render.cpp:624-677. The legacy (pre-v2) RenderListNode relocation path is a
// renderer TU. This build only accepts target render lists v2..4 (the same
// bound the committed reader enforces); if the legacy path is ever reached it
// is a named failure, not a silent skip.
void RenderListNode::Reallocate()
{
	WebSpike::Unsupported( "Target::RenderListNode::Reallocate (legacy render list)",
		__FILE__, __LINE__ );
}

// render.cpp:185-191
Scene::Scene()
{
	m_streamData.m_pScene = this;
	m_pDebugName = 0;
	m_maxLodToLoad = INT_MAX;
	m_iFXReloadIndex = 0;
}

// render.cpp:193-198
Scene::~Scene()
{
	g_resourceAllocatorMutex.Wait();
	m_resourceBlocks.Destroy();
	g_resourceAllocatorMutex.Release();
}

// render.cpp:200-216 (the const overload forwards, exactly as upstream)
const Node* Scene::GetNodePtr( const ResourceIndex& i ) const
{
	return const_cast<Scene*>( this )->GetNodePtr( i );
}

Node* Scene::GetNodePtr( const ResourceIndex& i )
{
	S32 block = i.GetBlock();
	S32 index = i.GetIndex();

	if ( block > -1 && m_resourceBlocks[ block ].GetLod() > -1 )
		return m_resourceBlocks[ block ].GetNodePtr( index );
	else if ( block == -1 && index == 0 )
		return &m_rootNode;
	else
		return 0;
}

// render.cpp:683-691. The destructor only reaches FX::ReleaseEffect when a
// shader was loaded, which cannot happen without the FX system; that call is a
// fail-loud abort in display_fail_loud.cpp.
Effect::Effect()
{
	m_pFX = 0;
}

Effect::~Effect()
{
	FX::ReleaseEffect( m_pFX );
}

// render.cpp:49-59. The installed reference levels are PC archives: the
// serialiser's platform tag inside them is PLATFORM_TYPE_PC (asserted by
// archive.cpp:326). This is the file's platform identity, not a fallback.
PlatformType GetPlatformType()
{
	return PLATFORM_TYPE_PC;
}

// render.cpp:31. SharedTextureList's deserialiser (archive.cpp:1079) asks the
// manager for an existing texture; the singleton storage lives in the renderer
// TU.
SharedTextureManager SharedTextureManager::s_instance;

} // namespace Target
} // namespace RenderingData

// core/source/btl/allocators/stackallocator.cpp:4. The Target::StreamData
// deserialiser (archive.cpp:302-308) uses the system stack allocator for the
// variable-sized ChunkInfo vectors.
Btl::StackAllocatorSystem Btl::StackAllocatorSystem::s_instance;

// graphics/display/source/view/ViewFrustum.cpp:8-15, reproduced because that TU
// includes the DX11 display device headers. StreamData contains a
// StreamerRequestWorker whose RequestInfo stores a C_ViewFrustum by value
// (streamrequest.h:36), so its constructor and destructor are needed even
// though this slice never evaluates a frustum. Both bodies are empty upstream.
namespace Display
{
C_ViewFrustum::C_ViewFrustum() :
	m_PlaneCount(0)
{
}

C_ViewFrustum::~C_ViewFrustum()
{
}
}
