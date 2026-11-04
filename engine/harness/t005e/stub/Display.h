#ifndef STREAM_SPIKE_DISPLAY_H
#define STREAM_SPIKE_DISPLAY_H
// Probe-only display facade: enough declarations for the streaming headers.
// Any translation unit that actually calls the renderer fails to link, because
// no definition of these classes or of Display::Device() is provided.
#include <Core/Core.h>
#include <btl/containers/vector.h>
#include <core/maths.h>
#include <system/time/Time.h>
#include <system/memory/MemoryTracker.h>

namespace Display2
{
    class C_IndexBuffer {};
    class C_VertexBuffer {};
    class C_VertexDeclaration {};
    class C_Texture {};
    class C_VertexShader {};
    class C_PixelShader {};
}

namespace Display
{
    class C_Texture2D {};
    class C_Device {};
    class C_View {};
    enum E_TextureAddress { E_TextureAddress_Wrap, E_TextureAddress_Clamp };
    enum E_TextureFilter { E_TextureFilter_Point, E_TextureFilter_Linear };
}
#endif
