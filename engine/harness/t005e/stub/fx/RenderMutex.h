#ifndef STREAM_SPIKE_FX_RENDERMUTEX_H
#define STREAM_SPIKE_FX_RENDERMUTEX_H
// PC-preprocess-only facade (see stub/Display.h). archive.cpp includes
// fx/RenderMutex.h only in the non-web branch; these are the declarations it
// needs for /P. Nothing here is compiled on wasm32.
namespace FX
{
	inline void LockSerialiseMutex() {}
	inline void ReleaseSerialiseMutex() {}
}
#endif
