/* smoke_sched.cpp - scheduler smoke for the TL_PLAT_WEB single-context backend.
 *
 * SPIKE DRIVER, not engine code and not a game claim. It runs the T-005c
 * acceptance cases that can be checked in node without a game:
 *
 *   A2  group dependency. Group B depends on group A. B's task is enqueued
 *       FIRST, so if the drain ignored group filtering or the dependency, B
 *       would run before A or A would be stranded. The observed *task order*
 *       (not just the counts) must be A then B; a second pair (C<-D) is
 *       satisfied by Flush(D) alone, which must recurse into C.
 *   A3  one task per *game* policy (SchedulerConfig.cpp:34-50), including
 *       piStreamer = {0,0,7,7,7,7,7,7}. Column 0 is the only execution context,
 *       so without policy flattening a streamer task can never be popped and
 *       Flush cannot terminate. Each task must run exactly once.
 *   A4  serial layout: GetNumWorkers() == 0, jqGetMaxWorkers() == 0, and
 *       Flush(group, false) still runs the task (the documented bRunJobs
 *       deviation), plus the queue layout the backend relies on.
 *
 * argv[1] selects a fail-loud case instead of the normal run:
 *   abort-event   MT::Event::Wait          -> must abort, never block
 *   abort-thread  tlWaitForThread          -> must abort
 *   abort-policy  an all-zero policy       -> must abort with the exact reason
 *   abort-label   AddGroupDependency(JQ_GROUP_LABEL, U32*) -> must abort with
 *                 the API name: only the renderer can advance a fence
 * Each is a separate process because the contract is "the process dies".
 */
#include <core/Core.h>          /* PCH-equivalent: U32, assert, INTPTR */
#include "system/scheduler/jobqueue.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

namespace
{
struct JobCtx
{
	int index;
	int observed;
};

JobCtx g_ctx[8];
int    g_out[8];
int    g_ran[8];

/* Task order, recorded from inside the job body. IDs 0..3 render as A..D. */
int g_seq[8];
int g_seqCount = 0;

void Record( int id )
{
	if ( g_seqCount < (int)( sizeof( g_seq ) / sizeof( g_seq[0] ) ) )
		g_seq[g_seqCount++] = id;
}

const char* Seq()
{
	static char text[16];
	int i = 0;
	for ( ; i < g_seqCount && i < 15; i++ )
		text[i] = (char)( 'A' + g_seq[i] );
	text[i] = '\0';
	return text;
}

void SpikeJob( Scheduler::Task* Batch )
{
	JobCtx* ctx = (JobCtx*)Batch->Input;
	ctx->observed = ctx->index + 1;
	g_ran[ctx->index]++;
}

void SeqJob( Scheduler::Task* Batch )
{
	JobCtx* ctx = (JobCtx*)Batch->Input;
	ctx->observed = ctx->index + 1;
	g_ran[ctx->index]++;
	Record( ctx->index );
}

Scheduler::jqModule g_module( SpikeJob, "spike.job" );
Scheduler::jqModule g_seqModule( SeqJob, "spike.seqjob" );

/* The four real game policies, verbatim from SchedulerConfig.cpp:34-50. */
const Scheduler::Policy g_gamePolicies[4][8] =
{
	{  7,  7,  7,  7,  7,  7,  7,  7 },   // piMed
	{ 10, 10, 10, 10, 10, 10, 10, 10 },   // piHigh
	{  7,  7,  7,  0,  0,  0,  0,  0 },   // piOneSPU   - only columns 0..2 set
	{  0,  0,  7,  7,  7,  7,  7,  7 },   // piStreamer - column 0 is 0
};
const char* g_policyNames[4] = { "piMed", "piHigh", "piOneSPU", "piStreamer" };

void Fail( const char* what )
{
	fprintf( stderr, "[smoke] FAILED: %s\n", what );
	fflush( stderr );
	abort();
}
} // namespace

int main( int argc, char** argv )
{
	const char* mode = ( argc > 1 ) ? argv[1] : "";

	/* --- fail-loud cases: web-only, each one must kill the process --------- */
#if defined( PLATFORM_WEB )
	if ( strcmp( mode, "abort-event" ) == 0 )
	{
		MT::SpuEvent event;
		event.Wait( 1 );
		printf( "NOT-REACHED\n" );
		return 0;
	}
	if ( strcmp( mode, "abort-thread" ) == 0 )
	{
		tlWaitForThread( 0 );
		printf( "NOT-REACHED\n" );
		return 0;
	}
	if ( strcmp( mode, "abort-policy" ) == 0 )
	{
		const Scheduler::Policy zero[8] = { 0, 0, 0, 0, 0, 0, 0, 0 };
		Scheduler::CreatePolicy( zero );    /* must abort: unrepresentable */
		printf( "NOT-REACHED\n" );
		return 0;
	}
	if ( strcmp( mode, "abort-label" ) == 0 )
	{
		Scheduler::PolicyHandle policy = Scheduler::CreatePolicy( g_gamePolicies[0] );
		Scheduler::Init();
		Scheduler::Start();
		Scheduler::SetGroupPoolSize( 16 );

		/* A fence nobody can advance in this build: the renderer owns it. */
		static U32 s_fenceValue = 0;
		Scheduler::GroupHandle group = Scheduler::CreateGroup( true );
		Scheduler::AddGroupDependency( group, &s_fenceValue );   /* JQ_GROUP_LABEL */

		g_ctx[0].index = 0; g_ctx[0].observed = 0; g_ran[0] = 0;
		Scheduler::AddTask( g_module, &g_ctx[0], &g_out[0], group,
		                    (int)policy, NULL, 0 );
		Scheduler::Flush( group );          /* must abort, not spin */
		printf( "NOT-REACHED\n" );
		return 0;
	}
#endif /* PLATFORM_WEB */

	/* --- A4: the queue layout the backend depends on --------------------- */
	const int queuePtrBytes = (int)sizeof( Scheduler::jqAtomicQueuePtr<U32> );
	const int queuePtrAlign = (int)alignof( Scheduler::jqAtomicQueuePtr<U32> );
	const int paramBytes    = (int)sizeof( ((Scheduler::Task*)0)->ParamData );
	const int taskBytes     = (int)sizeof( Scheduler::Task );

	/* The queue pointer is a pointer+count pair in a union with the widest
	 * atomic the platform uses: 16 bytes/cmpxchg16b on x64, 8 bytes/64-bit CAS
	 * everywhere else (jqAtomicQueuePtr, jobqueue_task_queue_lf.h:28-95). */
#if defined( _WIN64 )
	const int expectedQueueBytes = 16, expectedQueueAlign = 16, expectedParamBytes = 96;
#elif defined( __wasm32__ )
	const int expectedQueueBytes = 8,  expectedQueueAlign = 8,  expectedParamBytes = 48;
#else
	const int expectedQueueBytes = 8,  expectedQueueAlign = 4,  expectedParamBytes = 48;
#endif

	if ( queuePtrBytes != expectedQueueBytes || queuePtrAlign != expectedQueueAlign )
		Fail( "jqAtomicQueuePtr does not match the platform's queue CAS layout" );
	if ( paramBytes != expectedParamBytes )
		Fail( "Task::ParamData is not the expected size: AddTask's copy bound changed" );

	/* --- A3: one policy per game entry, created before Init ------------- */
	Scheduler::PolicyHandle policies[4];
	for ( int i = 0; i < 4; i++ )
		policies[i] = Scheduler::CreatePolicy( g_gamePolicies[i] );
	printf( "policy count=4\n" );

	Scheduler::Init();
	printf( "step=init\n" );
	Scheduler::Start();
	printf( "step=start\n" );

	/* Same order as the game: SchedulerConfig.cpp:56-60 calls Init, Start and
	 * then SetGroupPoolSize before any CreateGroup. A group created while the
	 * pool is still NULL indexes it. */
	Scheduler::SetGroupPoolSize( 16 );
	printf( "step=pool\n" );

	printf( "layout queueptr=%d/%d paramdata=%d task=%d\n",
	        queuePtrBytes, queuePtrAlign, paramBytes, taskBytes );
	printf( "A4 workers=%d max_workers=%d\n",
	        Scheduler::GetNumWorkers(), Scheduler::jqGetMaxWorkers() );

	/* --- A4: Flush(group, false) must still run the task ----------------- */
	g_ctx[4].index = 4; g_ctx[4].observed = 0; g_ran[4] = 0; g_out[4] = 0;
	Scheduler::GroupHandle groupFalse = Scheduler::CreateGroup( true );
	Scheduler::AddTask( g_module, &g_ctx[4], &g_out[4], groupFalse,
	                    (int)policies[0], NULL, 0 );
	Scheduler::Flush( groupFalse, false );
	printf( "A4 flush_false ran=%d poll=%d\n", g_ran[4],
	        Scheduler::Poll( groupFalse ) ? 1 : 0 );
	Scheduler::DestroyGroup( groupFalse );

	/* --- A2: dependent groups -------------------------------------------- */
	Scheduler::GroupHandle groupA = Scheduler::CreateGroup( true );
	Scheduler::GroupHandle groupB = Scheduler::CreateGroup( true );
	Scheduler::AddGroupDependency( groupB, groupA );     /* B waits for A */

	/* B is enqueued FIRST on purpose. A drain that ignored the group filter
	 * would run B here; a drain that ignored the dependency would leave A
	 * stranded behind B. */
	for ( int phase = 0; phase < 2; phase++ )
	{
		int id = ( phase == 0 ) ? 1 : 0;                 /* B then A */
		g_ctx[id].index = id; g_ctx[id].observed = 0; g_ran[id] = 0; g_out[id] = 0;
		Scheduler::AddTask( g_seqModule, &g_ctx[id], &g_out[id],
		                    ( id == 0 ) ? groupA : groupB, (int)policies[0], NULL, 0 );
	}

	Scheduler::Flush( groupA );
	printf( "A2 phase1 seq=%s a_ran=%d b_ran=%d a_queue=%d b_queue=%d\n",
	        Seq(), g_ran[0], g_ran[1],
	        Scheduler::jqGetQueuedBatchCount( groupA ),
	        Scheduler::jqGetQueuedBatchCount( groupB ) );
	bool phase1Ok = ( strcmp( Seq(), "A" ) == 0 && g_ran[0] == 1 && g_ran[1] == 0
	                  && Scheduler::jqGetQueuedBatchCount( groupA ) == 0
	                  && Scheduler::jqGetQueuedBatchCount( groupB ) == 1 );

	Scheduler::Flush( groupB );
	printf( "A2 phase2 seq=%s b_ran=%d b_queue=%d\n",
	        Seq(), g_ran[1], Scheduler::jqGetQueuedBatchCount( groupB ) );
	bool phase2Ok = ( strcmp( Seq(), "AB" ) == 0 && g_ran[1] == 1
	                  && Scheduler::jqGetQueuedBatchCount( groupB ) == 0 );

	/* Second pair: only the dependent group is flushed. Flush must resolve the
	 * dependency itself (jobqueue_xenon.cpp:146-155 recurses), so C runs before
	 * D even though D was enqueued first. */
	Scheduler::GroupHandle groupC = Scheduler::CreateGroup( true );
	Scheduler::GroupHandle groupD = Scheduler::CreateGroup( true );
	Scheduler::AddGroupDependency( groupD, groupC );
	for ( int phase = 0; phase < 2; phase++ )
	{
		int id = ( phase == 0 ) ? 3 : 2;                 /* D then C */
		g_ctx[id].index = id; g_ctx[id].observed = 0; g_ran[id] = 0; g_out[id] = 0;
		Scheduler::AddTask( g_seqModule, &g_ctx[id], &g_out[id],
		                    ( id == 2 ) ? groupC : groupD, (int)policies[0], NULL, 0 );
	}
	Scheduler::Flush( groupD );
	printf( "A2 phase3 only_flush_D seq=%s c_ran=%d d_ran=%d\n",
	        Seq(), g_ran[2], g_ran[3] );
	bool phase3Ok = ( strcmp( Seq(), "ABCD" ) == 0 && g_ran[2] == 1 && g_ran[3] == 1
	                  && Scheduler::jqGetQueuedBatchCount( groupD ) == 0 );

	printf( "A2 verdict=%s\n", ( phase1Ok && phase2Ok && phase3Ok ) ? "ok" : "FAIL" );

	Scheduler::DestroyGroup( groupA );
	Scheduler::DestroyGroup( groupB );
	Scheduler::DestroyGroup( groupC );
	Scheduler::DestroyGroup( groupD );

	/* --- A3: one task per game policy ------------------------------------ */
	int totalRan = 0;
	for ( int i = 0; i < 4; i++ )
	{
		g_ctx[i].index = i; g_ctx[i].observed = 0; g_ran[i] = 0; g_out[i] = 0;

		Scheduler::GroupHandle group = Scheduler::CreateGroup( true );
		Scheduler::AddTask( g_module, &g_ctx[i], &g_out[i], group,
		                    (int)policies[i], NULL, 0 );
		Scheduler::Flush( group );          /* must terminate */

		bool polled = Scheduler::Poll( group );
		printf( "A3 %s ran=%d observed=%d poll=%d\n",
		        g_policyNames[i], g_ran[i], g_ctx[i].observed, polled ? 1 : 0 );
		if ( g_ran[i] == 1 && g_ctx[i].observed == i + 1 && polled )
			totalRan++;

		Scheduler::DestroyGroup( group );
	}
	printf( "A3 total=%d/4\n", totalRan );

	printf( "queue queued=%d executing=%d\n",
	        Scheduler::jqGetQueuedBatchCount(), Scheduler::jqGetExecutingBatchCount() );

	Scheduler::Shutdown();
	printf( "step=shutdown\n" );
	return 0;
}
