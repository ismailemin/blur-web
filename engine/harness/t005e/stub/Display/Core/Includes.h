#ifndef STREAM_SPIKE_DISPLAY_CORE_INCLUDES_H
#define STREAM_SPIKE_DISPLAY_CORE_INCLUDES_H
// Probe-only replacement for Display/Core/Includes.h. The real header pulls the
// D3D9/DXSDK or GCM headers; neither exists for wasm32 and neither is used by the
// streaming layer. Included headers in this spike use only the store/read API.
#endif
