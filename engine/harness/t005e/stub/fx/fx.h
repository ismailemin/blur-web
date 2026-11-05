#ifndef STREAM_SPIKE_FX_FX_H
#define STREAM_SPIKE_FX_FX_H
// Probe-only FX facade for the wasm32 level-archive spike.
//
// No FX system exists on this target. The streaming and archive headers store
// FX::Effect* / FX::I_Effect* and FX::ImmediateParameter by value or pointer
// (target.h:207,429 and streaming.h:521), so the names must exist. Every
// function declared here is implemented in
// engine/harness/t005e/display_fail_loud.cpp and aborts with its own name; no
// shader is loaded and no effect is created.
#include <Core/Core.h>
#include <btl/containers/bitvector.h>
#include <btl/utility/string.h>

namespace FX
{
	class I_Effect {};
	class Effect {};
	typedef U64 ImmediateParameter;
	typedef Btl::BitVectorTemplate<Btl::BitArrayBase<Btl::Vector<U32, Btl::VectorParameters_Array<4> > > > SharedBindingBits;

	struct BlendState
	{
		Display::E_Blend srcBlend;
		Display::E_Blend destBlend;
		Display::E_BlendOp blendOp;
		Display::E_Blend srcBlendAlpha;
		Display::E_Blend destBlendAlpha;
		Display::E_BlendOp blendOpAlpha;
		Display::E_Bool alphaToMaskEnable;
		Display::E_Bool alphaTestEnable;
		Display::E_CullMode cullMode;
		U32 alphaRef;
	};

	class SamplerStateManager
	{
	public:
		int CreateSamplerState( Display::E_TextureAddress, Display::E_TextureAddress,
			Display::E_TextureAddress, Display::E_TextureFilter,
			Display::E_TextureFilter, Display::E_TextureFilter, U32, bool, S8 );
	};

	class BlendStateManager
	{
	public:
		S32 InsertRenderState( const BlendState& );
	};

	extern SamplerStateManager g_SamplerStateMgr;
	extern BlendStateManager g_RenderStateMgr;

	Btl::String GetShaderPath();
	I_Effect* LoadEffect( const char* );
	void ReleaseEffect( I_Effect* );
}
#endif
