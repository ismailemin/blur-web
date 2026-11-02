/* web_runtime.cpp - the two fail-loud hooks the TL_PLAT_WEB headers need.
 *
 * SPIKE ARTIFACT, not engine code. Deliberately tiny: it prints to stderr and
 * aborts, so an unsupported wait can never look like success. The cronological
 * design decision is docs/work/analysis/t005-scheduler-design.md section 3.2:
 * "Never an infinite wait (browser hang, no console output), never a silent
 * return 0".
 */
#include <stdio.h>
#include <stdlib.h>

extern "C" unsigned tlWebThreadSpawnRefused = 0;
extern "C" unsigned tlWebSleepNoopCount = 0;

extern "C" void tlWebUnsupported( const char* what )
{
	fprintf( stderr,
	         "[platform/web] unsupported in a single-context build: %s "
	         "(spawn refusals so far: %u)\n",
	         what ? what : "(null)", tlWebThreadSpawnRefused );
	fflush( stderr );
	abort();
}
