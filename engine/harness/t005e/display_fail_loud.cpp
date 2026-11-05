/* display_fail_loud.cpp - the renderer boundary of the T-005e wasm32 spike.
 *
 * Every symbol here is a renderer entry point with no wasm implementation. It
 * prints the API name, the caller's source location and aborts. None of them
 * may return, so the engine can never mistake a missing device for a created
 * resource, and the archive path cannot silently degrade into a partial GPU
 * import.
 *
 * The harness runs the Scene archive with gpuCalls == 0: the whole point is
 * that the ChunkInfo table is reached without touching one of these.
 */
#include <stdio.h>
#include <stdlib.h>

#include <Display.h>
#include <fx/fx.h>

#include "engine_stream_prelude.h"

namespace Display2
{

C_Device* Device()
{
	// Returning a pointer would let a caller probe the device. There is no
	// device; reaching this function is itself the error.
	WebSpike::GpuCallAbort( "Display2::Device", __FILE__, __LINE__ );
	return 0;
}

void C_Device::CreateIndexBuffer( U32, U32, E_IndexFormat, C_IndexBuffer* )
{
	WebSpike::GpuCallAbort( "Display2::Device::CreateIndexBuffer", __FILE__, __LINE__ );
}

void C_Device::CreateVertexBuffer( U32, U32, C_VertexBuffer* )
{
	WebSpike::GpuCallAbort( "Display2::Device::CreateVertexBuffer", __FILE__, __LINE__ );
}

C_VertexDeclaration* C_Device::CreateVertexDeclaration( const C_VertexElement* )
{
	WebSpike::GpuCallAbort( "Display2::Device::CreateVertexDeclaration", __FILE__, __LINE__ );
	return 0;
}

void C_Device::DestroyIndexBuffer( C_IndexBuffer* )
{
	WebSpike::GpuCallAbort( "Display2::Device::DestroyIndexBuffer", __FILE__, __LINE__ );
}

void C_Device::DestroyVertexBuffer( C_VertexBuffer* )
{
	WebSpike::GpuCallAbort( "Display2::Device::DestroyVertexBuffer", __FILE__, __LINE__ );
}

void C_Device::SetTextureName( Display::C_Texture2D*, const char* )
{
	WebSpike::GpuCallAbort( "Display2::Device::SetTextureName", __FILE__, __LINE__ );
}

void C_Device::RemoveTexture( Display::C_Texture2D* )
{
	WebSpike::GpuCallAbort( "Display2::Device::RemoveTexture", __FILE__, __LINE__ );
}

void C_Device::FreeMemory( U32, U8*, int, E_MemoryType )
{
	WebSpike::GpuCallAbort( "Display2::Device::FreeMemory", __FILE__, __LINE__ );
}

void C_Device::AllocMemory( U32, U32, U8**, int, int, E_MemoryType )
{
	WebSpike::GpuCallAbort( "Display2::Device::AllocMemory", __FILE__, __LINE__ );
}

} // namespace Display2

namespace Display
{

C_Device* Device()
{
	WebSpike::GpuCallAbort( "Display::Device", __FILE__, __LINE__ );
	return 0;
}

void C_Device::DestroyTexture2D( C_Texture2D* )
{
	WebSpike::GpuCallAbort( "Display::Device::DestroyTexture2D", __FILE__, __LINE__ );
}

void CreateTexture2D( C_Texture2D*, void* )
{
	WebSpike::GpuCallAbort( "Display::CreateTexture2D", __FILE__, __LINE__ );
}

bool CreateTexture2DFromFile( const char*, C_Texture2D* )
{
	WebSpike::GpuCallAbort( "Display::CreateTexture2DFromFile", __FILE__, __LINE__ );
	return false;
}

void LoadTexture2D( C_Texture2D*, void* )
{
	WebSpike::GpuCallAbort( "Display::LoadTexture2D", __FILE__, __LINE__ );
}

void LoadTextureData2D( C_Texture2D*, void*, S32 )
{
	WebSpike::GpuCallAbort( "Display::LoadTextureData2D", __FILE__, __LINE__ );
}

void CloneTexture2D( C_Texture2D*, const C_Texture2D*, S32, S32, S32, U32 )
{
	WebSpike::GpuCallAbort( "Display::CloneTexture2D", __FILE__, __LINE__ );
}

void CopyTextureData2D( C_Texture2D*, const C_Texture2D* )
{
	WebSpike::GpuCallAbort( "Display::CopyTextureData2D", __FILE__, __LINE__ );
}

} // namespace Display

namespace FX
{

SamplerStateManager g_SamplerStateMgr;
BlendStateManager g_RenderStateMgr;

int SamplerStateManager::CreateSamplerState( Display::E_TextureAddress,
	Display::E_TextureAddress, Display::E_TextureAddress, Display::E_TextureFilter,
	Display::E_TextureFilter, Display::E_TextureFilter, U32, bool, S8 )
{
	WebSpike::GpuCallAbort( "FX::SamplerStateManager::CreateSamplerState", __FILE__, __LINE__ );
	return -1;
}

S32 BlendStateManager::InsertRenderState( const BlendState& )
{
	WebSpike::GpuCallAbort( "FX::BlendStateManager::InsertRenderState", __FILE__, __LINE__ );
	return -1;
}

Btl::String GetShaderPath()
{
	WebSpike::GpuCallAbort( "FX::GetShaderPath", __FILE__, __LINE__ );
	return Btl::String();
}

I_Effect* LoadEffect( const char* )
{
	WebSpike::GpuCallAbort( "FX::LoadEffect", __FILE__, __LINE__ );
	return 0;
}

void ReleaseEffect( I_Effect* pEffect )
{
	// Upstream Effect::~Effect() calls this with a null pointer for an effect
	// that was never loaded (render.cpp:688-691). Releasing nothing is not a
	// device call and must not abort.
	if ( pEffect == 0 )
		return;

	fprintf( stderr, "[t005e] FX::ReleaseEffect(%p)\n", (void*)pEffect );
	fflush( stderr );
	WebSpike::GpuCallAbort( "FX::ReleaseEffect", __FILE__, __LINE__ );
}

} // namespace FX
