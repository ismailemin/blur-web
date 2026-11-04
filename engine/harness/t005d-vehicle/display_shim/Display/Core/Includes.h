/* display_shim/Display/Core/Includes.h - T-005d vehicle spike.
 *
 * The racingphysics batch build force-includes racingphysics/stdafx.h, whose
 * `#ifndef PLATFORM_SPU` block includes seven Display headers. Display is the
 * DX11 renderer; it is not part of this spike and cannot compile on wasm32.
 *
 * This directory is put FIRST on the include path for the vehicle build only,
 * and every file in it is deliberately empty. It is not a substitute renderer:
 * a compiled translation unit that actually names a Display:: or DrawPrimitive::
 * symbol fails to compile, which is the fail-loud behaviour we want. The debug
 * draw TUs (cardebug.cpp, debug/draw.cpp, debug/colour.cpp, debugsliprecorder.cpp,
 * collisionspheres.cpp, collisioncache.cpp, infiniteplane.cpp) are therefore
 * excluded from the build; see docs/work/analysis/engine-vehicle-physics.md.
 */
#ifndef BLUR_SPIKE_DISPLAY_ABSENT_H
#define BLUR_SPIKE_DISPLAY_ABSENT_H
#endif
