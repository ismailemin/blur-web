#ifndef STREAM_SPIKE_DISPLAY_H
#define STREAM_SPIKE_DISPLAY_H
// Probe-only display facade for the wasm32 level-archive spike.
//
// This file is NOT engine code and is not a renderer. It exists because
// RenderingData::Target stores Display2/Display objects *by value*
// (target.h:89,107,132 and 353-357), so the streaming and archive headers need
// complete types before they can be compiled on a target that has no DX11.
//
// Two rules decide what is here:
//
//   1. DATA-ONLY TYPES ARE REAL TYPES. The enumerations below exist only to
//      satisfy the engine's switch statements in archive.cpp; every function
//      that would consume them is a GPU entry point and is implemented in
//      engine/harness/t005e/display_fail_loud.cpp, where it aborts with the
//      API name. The enumerator *values* are therefore opaque tokens: they are
//      never stored, compared or serialised on this target. Do not read them
//      as the engine's real DX11 values (those live in
//      graphics/display2/include/display2/context/D3D11Context.h, which needs
//      the absent D3D11 SDK).
//
//   2. NO CLASS HERE PRETENDS TO OWN A DEVICE. C_Texture2D::IsCreated() is
//      false, GetSize()/GetAddress()/GetFlags() are zero, and no buffer or
//      texture can be created. The one enumeration whose values are used in
//      arithmetic that can reach data, the Display::E_Usage_* flag set, is
//      copied from graphics/display/include/Display/device/DeviceTypesEnums.h
//      (0x10 / 0x02000000 / 0x40000000) because Texture::Destroy() and
//      ResourceBlock::SwapNew() OR it into a stored flag word.
#include <Core/Core.h>
#include <btl/containers/vector.h>
#include <core/maths.h>
#include <system/time/Time.h>
#include <system/memory/MemoryTracker.h>

namespace Display { class C_Texture2D; }

namespace Display2
{
	// Opaque tokens; see rule 1 above.
	enum E_VertexElementType
	{
		E_VertexElementType_Unknown,
		E_VertexElementType_S16_2,
		E_VertexElementType_S16_4,
		E_VertexElementType_S16_2N,
		E_VertexElementType_S16_4N,
		E_VertexElementType_F32_1,
		E_VertexElementType_F32_2,
		E_VertexElementType_F32_3,
		E_VertexElementType_F32_4,
		E_VertexElementType_F16_2,
		E_VertexElementType_F16_4,
		E_VertexElementType_U8_4,
		E_VertexElementType_U8_4N,
		E_VertexElementType_SHHD_3N,
	};

	enum E_VertexElementUsage
	{
		E_VertexElementUsage_Unknown,
		E_VertexElementUsage_Position,
		E_VertexElementUsage_BlendWeight,
		E_VertexElementUsage_BlendIndices,
		E_VertexElementUsage_Normal,
		E_VertexElementUsage_PSize,
		E_VertexElementUsage_TexCoord,
		E_VertexElementUsage_Tangent,
		E_VertexElementUsage_Binormal,
		E_VertexElementUsage_Colour,
	};

	enum E_IndexFormat { E_IndexFormat_16, E_IndexFormat_32, E_IndexFormat_Unknown };

	enum E_MemoryType { E_MemoryType_Texture };

	class C_VertexElement
	{
	public:
		void SetStream( S16 ) {}
		void SetOffset( U16 ) {}
		void SetType( E_VertexElementType ) {}
		void SetUsage( E_VertexElementUsage ) {}
		void SetUsageIndex( S8 ) {}
	};

	class C_VertexDeclaration {};
	class C_VertexElementArray {};

	class C_IndexBuffer
	{
	public:
		bool IsCreated() const { return false; }
		U32 GetFlags() const { return 0; }
		void* Lock() { return 0; }
		void Unlock() {}
		void* GetAddress() { return 0; }
	};

	class C_VertexBuffer
	{
	public:
		bool IsCreated() const { return false; }
		U32 GetFlags() const { return 0; }
		void* Lock() { return 0; }
		void Unlock() {}
		void* GetAddress() { return 0; }
	};

	class C_Texture {};
	class C_VertexShader {};
	class C_PixelShader {};

	class C_Device
	{
	public:
		void AllowOutOfMemory( bool ) {}
		void CreateIndexBuffer( U32, U32, E_IndexFormat, C_IndexBuffer* );
		void CreateVertexBuffer( U32, U32, C_VertexBuffer* );
		C_VertexDeclaration* CreateVertexDeclaration( const C_VertexElement* );
		void DestroyIndexBuffer( C_IndexBuffer* );
		void DestroyVertexBuffer( C_VertexBuffer* );
		void SetTextureName( Display::C_Texture2D*, const char* );
		void RemoveTexture( Display::C_Texture2D* );
		void FreeMemory( U32, U8*, int, E_MemoryType );
		void AllocMemory( U32, U32, U8**, int, int, E_MemoryType );
	};

	C_Device* Device();

	inline S32 GetWidth2D( const Display::C_Texture2D& ) { return 0; }
	inline S32 GetHeight2D( const Display::C_Texture2D& ) { return 0; }
	inline S32 GetLevels( const Display::C_Texture2D& ) { return 0; }
}

namespace Display
{
	// Opaque tokens; see rule 1 above.
	enum E_TextureAddress
	{
		E_TextureAddress_Wrap,
		E_TextureAddress_Clamp,
		E_TextureAddress_Mirror,
		E_TextureAddress_Border,
	};

	enum E_TextureFilter
	{
		E_TextureFilter_Point,
		E_TextureFilter_Linear,
		E_TextureFilter_Anisotropic,
	};

	// Flag word ORed into a stored texture flag by Texture::Destroy() /
	// ResourceBlock::SwapNew(). Values copied from
	// graphics/display/include/Display/device/DeviceTypesEnums.h:480-504.
	enum E_UsageFlag
	{
		E_Usage_Indirect     = 0x00000010,
		E_Usage_DoNotReload  = 0x02000000,
		E_Usage_Streamed     = 0x40000000,
	};

	// Opaque tokens; see rule 1 above.
	enum E_PrimitiveType { E_PrimitiveType_PointList, E_PrimitiveType_TriangleList, E_PrimitiveType_TriangleStrip, E_PrimitiveType_QuadList, E_PrimitiveType_Unknown };
	enum E_Blend { E_Blend_Zero, E_Blend_One, E_Blend_SrcColour, E_Blend_InvSrcColour, E_Blend_SrcAlpha, E_Blend_InvSrcAlpha, E_Blend_DstAlpha, E_Blend_InvDstAlpha, E_Blend_DstColour, E_Blend_InvDstColour, E_Blend_Unknown };
	enum E_BlendOp { E_BlendOp_Add, E_BlendOp_Subtract, E_BlendOp_Min, E_BlendOp_Max, E_BlendOp_RevSubtract, E_BlendOp_Unknown };
	enum E_CullMode { E_CullMode_Default, E_CullMode_None, E_CullMode_Reversed };
	enum E_Bool { E_Bool_False, E_Bool_True };
	enum E_AllocHeap { E_AllocHeap_Default };
	enum E_AllocType { E_AllocType_Start };
	enum E_TextureFormat { E_TextureFormat_DXT1, E_TextureFormat_DXT5 };

	class C_Texture2D
	{
	public:
		// A facade texture is never created; see rule 2.
		bool IsCreated() const { return false; }
		U32 GetFlags() const { return 0; }
		void SetFlags( U32 ) {}
		U32 GetSize() const { return 0; }
		U8* GetAddress() { return 0; }
		const U8* GetAddress() const { return 0; }
		E_TextureFormat GetFormat() const { return E_TextureFormat_DXT1; }
		void SetAddress( U8* ) {}
	};

	class C_Device
	{
	public:
		void DestroyTexture2D( C_Texture2D* );
		void AllowOutOfMemory( bool ) {}
	};

	C_Device* Device();

	// Every one of these aborts (display_fail_loud.cpp). They exist so the
	// engine's GPU deserialisers still compile; the archive path this spike
	// runs never calls one.
	void CreateTexture2D( C_Texture2D*, void* );
	bool CreateTexture2DFromFile( const char*, C_Texture2D* );
	void LoadTexture2D( C_Texture2D*, void* );
	void LoadTextureData2D( C_Texture2D*, void*, S32 );
	void CloneTexture2D( C_Texture2D*, const C_Texture2D*, S32, S32, S32, U32 );
	void CopyTextureData2D( C_Texture2D*, const C_Texture2D* );
}

#define GPU_VERTEX_ELEMENT_END() Display2::C_VertexElement()

#endif
