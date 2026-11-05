/* web_drawlist.cpp - P27 CPU-side draw-list records for the T-005e spike.
 *
 * The archive deserialisers in renderingdata/.../target/archive.cpp call the
 * accessors below instead of creating GPU objects. This file owns the storage
 * and nothing else: it does not interpret geometry, does not order draws and
 * does not know about any level. Everything it holds was written by an engine
 * deserialiser from archive bytes.
 *
 * The arrays are fixed and bounded (engine_stream_prelude.h); an overflow is
 * reported through a counter and turned into a fail-loud Unsupported() by the
 * caller, never a truncation.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "engine_stream_prelude.h"

namespace WebSpike
{

static DrawListState s_draws;

DrawListState& Draws()
{
	return s_draws;
}

unsigned char* RetainBytes( int bytes, int* arenaOffset )
{
	if ( bytes <= 0 )
		return 0;

	if ( s_draws.arena == 0 )
	{
		s_draws.arena = malloc( kArenaBytes );
		if ( s_draws.arena == 0 )
			return 0;
		s_draws.arenaCapacity = kArenaBytes;
	}

	if ( bytes > s_draws.arenaCapacity - s_draws.arenaUsed )
		return 0;

	unsigned char* p = (unsigned char*)s_draws.arena + s_draws.arenaUsed;
	*arenaOffset = s_draws.arenaUsed;
	s_draws.arenaUsed += bytes;
	return p;
}

DeclRecord* AddDeclaration( int elementCount )
{
	if ( elementCount < 0 || elementCount > kMaxDeclElements )
	{
		++s_draws.declarationOverflow;
		return 0;
	}

	if ( s_draws.declarations >= kMaxDeclarations )
	{
		++s_draws.declarationOverflow;
		return 0;
	}

	DeclRecord* p = &s_draws.decl[ s_draws.declarations ];
	p->count = elementCount;

	for ( int i = 0; i < kMaxDeclElements; i++ )
	{
		p->elements[ i ].stream = 0;
		p->elements[ i ].offset = 0;
		p->elements[ i ].type = 0;
		p->elements[ i ].method = 0;
		p->elements[ i ].usage = 0;
		p->elements[ i ].usageIndex = 0;
	}

	++s_draws.declarations;
	return p;
}

BufferRecord* AddBuffer( int kind, int count, int stride, int bytes )
{
	const int index = ( kind == 0 ) ? s_draws.vertexBuffers : s_draws.indexBuffers;

	if ( index >= kMaxBuffers )
	{
		++s_draws.bufferOverflow;
		return 0;
	}

	BufferRecord* p = ( kind == 0 ) ? &s_draws.vertexBuffer[ index ]
		: &s_draws.indexBuffer[ index ];

	p->kind = kind;
	p->count = count;
	p->stride = stride;
	p->bytes = bytes;
	p->alignment = 0;
	p->compression = 0;
	p->endianSwap = 0;
	p->payloadRetained = 0;
	p->payloadOffset = -1;
	p->streamOffset = 0;

	if ( kind == 0 )
		++s_draws.vertexBuffers;
	else
		++s_draws.indexBuffers;

	return p;
}

PrimitiveRecord* AddPrimitive()
{
	if ( s_draws.primitives >= kMaxPrimitives )
	{
		++s_draws.primitiveOverflow;
		return 0;
	}

	PrimitiveRecord* p = &s_draws.primitive[ s_draws.primitives ];
	memset( p, 0, sizeof( *p ) );
	++s_draws.primitives;
	return p;
}

void ResetChunkRecords()
{
	s_draws.vertexBuffers = 0;
	s_draws.indexBuffers = 0;
	s_draws.primitives = 0;
	s_draws.arenaUsed = 0;
	s_draws.bufferOverflow = 0;
	s_draws.primitiveOverflow = 0;
	s_draws.lodOverflow = 0;
	s_draws.streamOverflow = 0;
	s_draws.arenaExhausted = 0;
	s_draws.compressedBuffers = 0;
	s_draws.resourceLods = 0;
	s_draws.resourceNodes = 0;
	s_draws.resourceTextures = 0;
	s_draws.textureLods = 0;
	s_draws.texturePayloadBytes = 0;
	s_draws.texturesDiscarded = 0;
}

void ResetDrawList()
{
	memset( &s_draws, 0, sizeof( s_draws ) );
}

} // namespace WebSpike
