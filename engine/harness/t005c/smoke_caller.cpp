/* smoke_caller.cpp - the first real engine consumer of the scheduler.
 *
 * SPIKE DRIVER, not engine code and not a game claim. It drives the engine's own
 * compression classes through the job queue:
 *
 *   Compression::C_Deflate::Create/Start/Finish   (misc_shared/.../Deflate.cpp)
 *   Compression::C_Inflate::Create/Start/Finish   (misc_shared/.../Inflate.cpp)
 *   Compression::InflateTask / DeflateModule      (the job bodies those queue)
 *
 * Why this caller: it is the cheapest engine code that really calls
 * Scheduler::AddTask and Scheduler::Flush with real payloads, it is on the
 * T-005c A1 list, and its result is checkable byte for byte (a zlib round
 * trip), so "the task ran" and "the task did the right thing" are separate,
 * observable facts.
 *
 * Build note: Deflate.cpp includes "../../../../Vendor/Zlib/Current_Mercury/
 * Zlib.h", a path the engine's build layout provides. verify_overlay.py
 * materialises that directory from code/vendor/zlib/current_mercury; without it
 * this file compiles but its module TU does not.
 *
 * Reported facts:
 *   deferred  the payload buffer is untouched between Start() and Finish(),
 *             so the job did not run inline - it was queued and executed by the
 *             cooperative Flush drain.
 *   ran       the buffer holds the zlib CMF byte after Finish().
 *   roundtrip deflate -> inflate reproduces the input exactly.
 */
#include <core/Core.h>          /* PCH-equivalent: U32, assert, INTPTR */
#include "system/scheduler/jobqueue.h"

#include <Misc_Shared/Compression/Deflate.h>
#include <Misc_Shared/Compression/Inflate.h>

#include <stdio.h>
#include <string.h>

namespace
{
const Scheduler::Policy g_policy[8] = { 7, 7, 7, 7, 7, 7, 7, 7 };   // piMed
const char* const kText = "blur-scheduler-caller-roundtrip";
} // namespace

int main()
{
	Scheduler::PolicyHandle policy = Scheduler::CreatePolicy( g_policy );
	Scheduler::Init();
	Scheduler::Start();
	Scheduler::SetGroupPoolSize( 16 );
	printf( "caller setup ok\n" );

	U8 input[64]  = { 0 };
	U8 packed[256] = { 0 };
	U8 output[64] = { 0 };
	const U32 nText = (U32)strlen( kText ) + 1;
	memcpy( input, kText, nText );

	/* --- deflate: queue it, prove it was deferred, then flush ----------- */
	memset( packed, 0xAA, sizeof( packed ) );
	Compression::C_Deflate deflate;
	deflate.SetPolicy( policy );
	deflate.Create();                       /* its own group */
	deflate.Start( input, nText, packed, sizeof( packed ) );
	const bool deferred = packed[0] == 0xAA;

	U32 packedSize = 0;
	deflate.Finish( packedSize );
	const bool ran = packedSize > 0 && packed[0] == 0x78;   /* RFC1950 CMF, CM=deflate */
	printf( "caller deflate deferred=%d ran=%d packed=%u cmf=0x%02x\n",
	        deferred ? 1 : 0, ran ? 1 : 0, packedSize, packed[0] );

	/* --- inflate: same pattern, into a group the caller owns ------------- */
	Scheduler::GroupHandle group = Scheduler::CreateGroup( true );
	Compression::C_Inflate inflate;
	inflate.SetPolicy( policy );
	inflate.Create( group );
	memset( output, 0xAA, sizeof( output ) );
	inflate.Start( packed, packedSize, output, sizeof( output ) );
	const bool inflateDeferred = output[0] == 0xAA;
	inflate.Finish();                       /* Flush(group) */
	const bool inflateRan = output[0] != 0xAA;
	const bool equal = memcmp( output, kText, nText ) == 0;
	printf( "caller inflate deferred=%d ran=%d equal=%d text=%s\n",
	        inflateDeferred ? 1 : 0, inflateRan ? 1 : 0, equal ? 1 : 0,
	        equal ? (const char*)output : "(mismatch)" );

	Scheduler::DestroyGroup( group );
	deflate.Destroy();
	Scheduler::Shutdown();
	printf( "caller shutdown ok\n" );
	return ( deferred && ran && inflateDeferred && inflateRan && equal ) ? 0 : 1;
}
