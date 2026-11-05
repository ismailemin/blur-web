/* web_scene_report.cpp - T-005e counters and fail-loud helpers.
 *
 * The report is written by the PLATFORM_WEB branches in the engine's archive
 * and streamer TUs (see engine/patches/t005b-stream-overlay.patch) and read by
 * engine/harness/t005e/stream_harness.cpp. It records what the engine did, not
 * what the probe expected; verify_stream.py compares it to the two committed
 * readers.
 */
#include <stdio.h>
#include <stdlib.h>

#include "engine_stream_prelude.h"

namespace WebSpike
{

static SceneReport s_report;

SceneReport& Report()
{
	return s_report;
}

void GpuCallAbort( const char* api, const char* file, int line )
{
	++s_report.gpuCalls;
	++s_report.gpuCallsRefused;
	fprintf( stderr, "[t005e] GPU call refused: %s at %s:%d (no device on wasm32)\n",
		api, file, line );
	fflush( stderr );
	abort();
}

void Unsupported( const char* what, const char* file, int line )
{
	++s_report.unsupportedCalls;
	fprintf( stderr, "[t005e] unsupported engine path: %s at %s:%d\n",
		what, file, line );
	fflush( stderr );
	abort();
}

void ArchiveUnderflow( const char* file, int line, unsigned long long wanted,
	unsigned long long available )
{
	fprintf( stderr, "[t005e] archive read past its bounds at %s:%d: wanted %llu, "
		"available %llu\n", file, line, wanted, available );
	fflush( stderr );
	abort();
}

void PerfEvent( const char* )
{
	++s_report.perfEvents;
}

} // namespace WebSpike
