// T-005d vehicle physics spike: run the REAL RacingPhysics car integrator on a
// REAL Gravity scene built from usa_la_river/Level.levelphysics, for a fixed
// number of ticks, twice (settle, then constant throttle).
//
// Harness code, not engine code. It links upstream RacingPhysics + Gravity
// translation units (see engine/verify_vehicle.py) and only:
//   * loads the level's `Main` block through Gravity's own C_ImportScene,
//   * builds the scene the way GameResource::C_LevelInstance does
//     (C_ImportSceneStaticInstance with the game's desiredSize / maxCellSize),
//   * fills a CarDynamicsXt from a text field list produced by the verifier from
//     the real gamedata\xt\racingphysics.bin record (RP_CarDynamics), checking
//     every field name, so no value is invented here,
//   * creates one Gravity body for the car and hands it to Car::SetGravityBody,
//   * calls C_Scene::SetMinTimeStep(-1) and C_Scene::Simulate(dt) once per tick,
//     which is the game's own driver (GameWorld.cpp:2569, 2601-2627),
//   * reports position/orientation/velocity/wheel state per tick.
//
// Nothing here integrates a body, evaluates a tyre force or ray-casts a wheel
// itself; those are all the engine's calls. The two things this harness does
// choose are the car's ground pose (a ray cast against the real mesh) and the
// box collision proxy handed to Gravity (the retail composite shape comes from
// the model import, which is out of scope); both are reported in the document.

#include "stdafx.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>

#include <system/serialise/I_BinaryStream.h>
#include <system/serialise/C_MemoryStream.h>
#include <gravity/sdk/PhysicsSDK.h>
#include <gravity/sdk/Scene.h>
#include <gravity/sdk/BodyHelper.h>
#include <gravity/sdk/ShapeDescriptors.h>
#include <gravity/sharedphysics/constants.h>
#include <gravity/narrowphase/LineCollisionCache.h>

#include <racingphysics/vehicles/car/car.h>
#include <racingphysics/physics/physicstimer.h>

// ---------------------------------------------------------------------------
// xt2 runtime symbols the RacingPhysics code references but never calls on this
// path. The XT importer is not ported, so the two globals a default XtHandle
// needs are defined here (both are plain data), and the four record helpers are
// fail-loud: if a code path ever asks for real XT records it aborts instead of
// returning a plausible zero.
// ---------------------------------------------------------------------------
XtType gXtNullType;
XtRecord gXtNullRecord;

namespace
{
	void FailFatal( const char* what )
	{
		std::fprintf( stderr, "[vehicle-spike] %s\n", what );
		std::fflush( stderr );
		std::abort();
	}

	void XtMissing( const char* what )
	{
		std::fprintf( stderr, "[vehicle-spike] xt2 runtime is not ported: %s called\n", what );
		std::fflush( stderr );
		std::abort();
	}
}

// Declared by the T-005d overlay in car.h; the host owns the implementation so
// the engine source never decides how a spike dies.
namespace RacingPhysics
{
	void WebPhysicsFatal( const char* what ) { FailFatal( what ); }
}

// Gravity's fluid collision TU calls this debug-render accessor. Display is not
// ported, so any use is a hard failure rather than a null dereference later.
namespace DbUtil
{
	class I_DebugRenderSys;
	I_DebugRenderSys* DefaultDebugRenderSys()
	{
		FailFatal( "DbUtil::DefaultDebugRenderSys() called: no renderer on the web build" );
		return 0;
	}
}

XtU8* XtGetRecordBaseAddr( const XtRecord* ) { XtMissing( "XtGetRecordBaseAddr" ); return 0; }
XtU32 XtGetRecordSize( const XtRecord* ) { XtMissing( "XtGetRecordSize" ); return 0; }
XtU32 XtGetRecordFixupCount( const XtRecord* ) { XtMissing( "XtGetRecordFixupCount" ); return 0; }
void XtGenerateRecordFixups( const XtRecord*, XtU32*, XtU32 ) { XtMissing( "XtGenerateRecordFixups" ); }

namespace spike
{

// ------------------------------------------------------------------- output

struct Out
{
	char* p;
	size_t cap;
	size_t n;
	bool overflow;

	Out( char* buf, size_t capacity ) : p( buf ), cap( capacity ), n( 0 ), overflow( false ) {}
	void raw( const char* s, size_t len )
	{
		if ( overflow ) return;
		if ( n + len + 1 > cap ) { overflow = true; return; }
		std::memcpy( p + n, s, len );
		n += len;
	}
	void raw( const char* s ) { raw( s, std::strlen( s ) ); }
	void ch( char c ) { raw( &c, 1 ); }
	void u32( unsigned v ) { char b[16]; std::snprintf( b, sizeof b, "%u", v ); raw( b ); }
	void i32( int v ) { char b[16]; std::snprintf( b, sizeof b, "%d", v ); raw( b ); }
	void u64hex( unsigned long long v ) { char b[24]; std::snprintf( b, sizeof b, "\"%016llx\"", v ); raw( b ); }
	void bits( float v )
	{
		unsigned u;
		std::memcpy( &u, &v, 4 );
		char b[16];
		std::snprintf( b, sizeof b, "\"%08x\"", u );
		raw( b );
	}
	void key( const char* k ) { ch( '"' ); raw( k ); raw( "\":" ); }
	void str( const char* s )
	{
		ch( '"' );
		for ( ; *s; ++s )
		{
			unsigned char c = (unsigned char)*s;
			if ( c == '"' || c == '\\' ) { ch( '\\' ); ch( (char)c ); }
			else if ( c < 0x20 ) { char b[8]; std::snprintf( b, sizeof b, "\\u%04x", c ); raw( b ); }
			else ch( (char)c );
		}
		ch( '"' );
	}
	void vec( const float* v, int count )
	{
		ch( '[' );
		for ( int i = 0; i < count; ++i ) { if ( i ) ch( ',' ); bits( v[i] ); }
		ch( ']' );
	}
};

// ---------------------------------------------------------------- sha256/fnv

struct Sha256
{
	unsigned s[8];
	unsigned long long bytes;
	unsigned char buf[64];
	size_t fill;

	Sha256() { reset(); }

	void reset()
	{
		static const unsigned iv[8] = { 0x6a09e667u, 0xbb67ae85u, 0x3c6ef372u, 0xa54ff53au,
		                                0x510e527fu, 0x9b05688cu, 0x1f83d9abu, 0x5be0cd19u };
		std::memcpy( s, iv, sizeof s );
		bytes = 0;
		fill = 0;
	}

	static unsigned ror( unsigned x, int n ) { return ( x >> n ) | ( x << ( 32 - n ) ); }

	void block( const unsigned char* p )
	{
		static const unsigned k[64] = {
			0x428a2f98u,0x71374491u,0xb5c0fbcfu,0xe9b5dba5u,0x3956c25bu,0x59f111f1u,0x923f82a4u,0xab1c5ed5u,
			0xd807aa98u,0x12835b01u,0x243185beu,0x550c7dc3u,0x72be5d74u,0x80deb1feu,0x9bdc06a7u,0xc19bf174u,
			0xe49b69c1u,0xefbe4786u,0x0fc19dc6u,0x240ca1ccu,0x2de92c6fu,0x4a7484aau,0x5cb0a9dcu,0x76f988dau,
			0x983e5152u,0xa831c66du,0xb00327c8u,0xbf597fc7u,0xc6e00bf3u,0xd5a79147u,0x06ca6351u,0x14292967u,
			0x27b70a85u,0x2e1b2138u,0x4d2c6dfcu,0x53380d13u,0x650a7354u,0x766a0abbu,0x81c2c92eu,0x92722c85u,
			0xa2bfe8a1u,0xa81a664bu,0xc24b8b70u,0xc76c51a3u,0xd192e819u,0xd6990624u,0xf40e3585u,0x106aa070u,
			0x19a4c116u,0x1e376c08u,0x2748774cu,0x34b0bcb5u,0x391c0cb3u,0x4ed8aa4au,0x5b9cca4fu,0x682e6ff3u,
			0x748f82eeu,0x78a5636fu,0x84c87814u,0x8cc70208u,0x90befffau,0xa4506cebu,0xbef9a3f7u,0xc67178f2u };
		unsigned w[64];
		for ( int i = 0; i < 16; ++i )
			w[i] = ( (unsigned)p[i * 4] << 24 ) | ( (unsigned)p[i * 4 + 1] << 16 ) |
			       ( (unsigned)p[i * 4 + 2] << 8 ) | (unsigned)p[i * 4 + 3];
		for ( int i = 16; i < 64; ++i )
		{
			unsigned a = w[i - 15], b = w[i - 2];
			unsigned s0 = ror( a, 7 ) ^ ror( a, 18 ) ^ ( a >> 3 );
			unsigned s1 = ror( b, 17 ) ^ ror( b, 19 ) ^ ( b >> 10 );
			w[i] = w[i - 16] + s0 + w[i - 7] + s1;
		}
		unsigned a = s[0], b = s[1], c = s[2], d = s[3], e = s[4], f = s[5], g = s[6], h = s[7];
		for ( int i = 0; i < 64; ++i )
		{
			unsigned S1 = ror( e, 6 ) ^ ror( e, 11 ) ^ ror( e, 25 );
			unsigned ch = ( e & f ) ^ ( ~e & g );
			unsigned t1 = h + S1 + ch + k[i] + w[i];
			unsigned S0 = ror( a, 2 ) ^ ror( a, 13 ) ^ ror( a, 22 );
			unsigned mj = ( a & b ) ^ ( a & c ) ^ ( b & c );
			unsigned t2 = S0 + mj;
			h = g; g = f; f = e; e = d + t1;
			d = c; c = b; b = a; a = t1 + t2;
		}
		s[0] += a; s[1] += b; s[2] += c; s[3] += d;
		s[4] += e; s[5] += f; s[6] += g; s[7] += h;
	}

	void update( const void* data, size_t len )
	{
		const unsigned char* p = (const unsigned char*)data;
		bytes += len;
		while ( len )
		{
			size_t take = 64 - fill;
			if ( take > len ) take = len;
			std::memcpy( buf + fill, p, take );
			fill += take;
			p += take;
			len -= take;
			if ( fill == 64 ) { block( buf ); fill = 0; }
		}
	}

	void finish( unsigned char digest[32] )
	{
		unsigned long long bits = bytes * 8;
		unsigned char pad = 0x80;
		update( &pad, 1 );
		unsigned char zero = 0;
		while ( fill != 56 ) update( &zero, 1 );
		unsigned char len[8];
		for ( int i = 0; i < 8; ++i ) len[i] = (unsigned char)( bits >> ( 56 - 8 * i ) );
		update( len, 8 );
		for ( int i = 0; i < 8; ++i )
		{
			digest[i * 4 + 0] = (unsigned char)( s[i] >> 24 );
			digest[i * 4 + 1] = (unsigned char)( s[i] >> 16 );
			digest[i * 4 + 2] = (unsigned char)( s[i] >> 8 );
			digest[i * 4 + 3] = (unsigned char)( s[i] );
		}
	}
};

static unsigned long long Fnv64( const void* data, size_t len )
{
	const unsigned char* p = (const unsigned char*)data;
	unsigned long long h = 0xcbf29ce484222325ull;
	for ( size_t i = 0; i < len; ++i ) { h ^= p[i]; h *= 0x100000001b3ull; }
	return h;
}

// --------------------------------------------------------------- field input

struct Fields
{
	const char* text;
	size_t len;
	size_t pos;
	int line;
	bool failed;
	char err[192];

	Fields( const char* t, size_t n ) : text( t ), len( n ), pos( 0 ), line( 0 ), failed( false ) { err[0] = 0; }

	bool note( const char* fmt, const char* a, int n )
	{
		if ( !failed )
		{
			std::snprintf( err, sizeof err, fmt, a, n );
			failed = true;
		}
		return false;
	}
	bool fail( const char* text )
	{
		if ( !failed ) { std::snprintf( err, sizeof err, "%s", text ); failed = true; }
		return false;
	}

	// next "key<tab>value" line; skips blank lines and '#' comments
	bool next( char* key, size_t keyCap, const char** value )
	{
		while ( !failed && pos < len )
		{
			size_t start = pos;
			while ( pos < len && text[pos] != '\n' ) ++pos;
			size_t end = pos;
			if ( pos < len ) ++pos;
			++line;
			if ( end > start && text[end - 1] == '\r' ) --end;
			size_t a = start;
			while ( a < end && ( text[a] == ' ' || text[a] == '\t' ) ) ++a;
			if ( a == end || text[a] == '#' ) continue;
			size_t tab = a;
			while ( tab < end && text[tab] != '\t' ) ++tab;
			if ( tab == end ) return note( "line %d: no tab", "", line );
			size_t klen = tab - a;
			if ( klen + 1 > keyCap ) return note( "line %d: key too long", "", line );
			std::memcpy( key, text + a, klen );
			key[klen] = 0;
			size_t v = tab + 1;
			*value = text + v;
			// terminate the value in place by returning a length via a sentinel
			return true;
		}
		return note( "unexpected end of field list at line %d", "", line );
	}

	// Values are tab separated; the caller only needs the token, so we copy it.
	bool token( const char* value, char* out, size_t cap )
	{
		size_t n = 0;
		while ( value[n] && value[n] != '\n' && value[n] != '\r' && value[n] != '\t' && n + 1 < cap )
		{
			out[n] = value[n];
			++n;
		}
		out[n] = 0;
		return n > 0;
	}

	bool expectKey( const char* expected, char* value, size_t cap )
	{
		char key[128];
		const char* v = 0;
		if ( !next( key, sizeof key, &v ) ) return false;
		if ( std::strcmp( key, expected ) != 0 )
		{
			if ( !failed )
			{
				std::snprintf( err, sizeof err, "line %d: expected '%s', got '%s'", line, expected, key );
				failed = true;
			}
			return false;
		}
		return token( v, value, cap );
	}

	bool f32( const char* name, float& out )
	{
		char v[32];
		if ( !expectKey( name, v, sizeof v ) ) return false;
		char* end = 0;
		unsigned bits = (unsigned)std::strtoul( v, &end, 16 );
		if ( !end || *end ) return note( "line %d: '%s' is not 8 hex digits", name, line );
		std::memcpy( &out, &bits, 4 );
		return true;
	}

	bool i32( const char* name, int& out )
	{
		char v[32];
		if ( !expectKey( name, v, sizeof v ) ) return false;
		char* end = 0;
		long n = std::strtol( v, &end, 10 );
		if ( !end || *end ) return note( "line %d: '%s' is not an integer", name, line );
		out = (int)n;
		return true;
	}

	bool boolean( const char* name, bool& out )
	{
		int v = 0;
		if ( !i32( name, v ) ) return false;
		if ( v != 0 && v != 1 ) return note( "line %d: '%s' is not 0/1", name, line );
		out = v != 0;
		return true;
	}

	bool text_value( const char* name, char* out, size_t cap )
	{
		char v[128];
		if ( !expectKey( name, v, sizeof v ) ) return false;
		std::snprintf( out, cap, "%s", v );
		return true;
	}

	bool f32Array( const char* name, XtArray<float>& arr, float* buf, int cap, int& countOut )
	{
		int n = 0;
		if ( !i32( name, n ) ) return false;
		if ( n < 0 || n > cap ) return note( "line %d: '%s' count out of range", name, n );
		for ( int i = 0; i < n; ++i )
		{
			char key[160];
			std::snprintf( key, sizeof key, "%s[%d]", name, i );
			if ( !f32( key, buf[i] ) ) return false;
		}
		arr.elements = buf;
		arr.count = n;
		countOut = n;
		return true;
	}

	bool pointArray( const char* name, XtArray<RacingPhysics::LinearGraphXt::Point>& arr,
	                 RacingPhysics::LinearGraphXt::Point* buf, int cap, int& countOut )
	{
		int n = 0;
		if ( !i32( name, n ) ) return false;
		if ( n < 0 || n > cap ) return note( "line %d: '%s' count out of range", name, n );
		for ( int i = 0; i < n; ++i )
		{
			char key[160];
			std::snprintf( key, sizeof key, "%s[%d].x", name, i );
			if ( !f32( key, buf[i].x ) ) return false;
			std::snprintf( key, sizeof key, "%s[%d].y", name, i );
			if ( !f32( key, buf[i].y ) ) return false;
		}
		arr.elements = buf;
		arr.count = n;
		countOut = n;
		return true;
	}
};

// ------------------------------------------------------------------ level io

static bool FindMainBlock( const unsigned char* data, size_t size, unsigned& offset, unsigned& len,
                           const char*& why )
{
	if ( size < 20 || std::memcmp( data, "  CP", 4 ) != 0 ) { why = "bad_pc_marker"; return false; }
	// root block header starts at 4: id[8] size u32 count u16 type s8 comp s8
	if ( std::memcmp( data + 4, "Physic", 6 ) != 0 ) { why = "bad_root_block"; return false; }
	unsigned rootSize;
	std::memcpy( &rootSize, data + 12, 4 );
	if ( rootSize > size - 4 || rootSize < 16 ) { why = "bad_root_size"; return false; }
	const unsigned rootEnd = 4 + rootSize;
	unsigned p = 4 + 16;
	while ( p + 16 <= rootEnd )
	{
		unsigned bsize;
		std::memcpy( &bsize, data + p + 8, 4 );
		if ( bsize < 16 || p + bsize > rootEnd ) { why = "bad_child_block"; return false; }
		if ( std::memcmp( data + p, "Main", 4 ) == 0 )
		{
			offset = p;
			len = bsize;
			return true;
		}
		p += bsize;
	}
	why = "main_block_missing";
	return false;
}

// -------------------------------------------------------------------- engine

struct MaterialMatrix
{
	// 1x1: every shape in this level declares physicsMaterial 0 and the car's
	// filter uses 0, so a single pair is what the solver can be asked for. The
	// values are the game's own defaults (Materials.cpp:35-42) used when the XT
	// friction table has no entry.
	SharedPhysics::C_MaterialPair pair;
	MaterialMatrix()
	{
		pair.m_Friction[0] = pair.m_Friction[1] = pair.m_Friction[2] = 0.65f;
		pair.m_RestitutionCoefficient = 0.05f;
	}
};

struct TickState
{
	float position[3];
	float axisX[3];
	float axisY[3];
	float axisZ[3];
	float velocity[3];
	float angular[3];
	float speed;
	bool wheelOnGround[4];
	float suspension[4];
	float wheelPosition[4][3];
	float wheelAngular[4];
	unsigned surfaceFlags[4];
	unsigned userData[4];
	float groundNormal[4][3];
};

static void SampleCar( RacingPhysics::Car& car, TickState& t )
{
	using RacingPhysics::Car;
	const Maths::C_Vertex& p = car.GetPosition();
	const Maths::HMat33 m( car.GetAxis().Matrix3() );
	const Maths::C_Vector& v = car.GetVelocity();
	const Maths::HVec3& w = car.GetAngularVelocity();	t.position[0] = p.X(); t.position[1] = p.Y(); t.position[2] = p.Z();
	t.axisX[0] = m.AX().X(); t.axisX[1] = m.AX().Y(); t.axisX[2] = m.AX().Z();
	t.axisY[0] = m.AY().X(); t.axisY[1] = m.AY().Y(); t.axisY[2] = m.AY().Z();
	t.axisZ[0] = m.AZ().X(); t.axisZ[1] = m.AZ().Y(); t.axisZ[2] = m.AZ().Z();
	t.velocity[0] = v.X(); t.velocity[1] = v.Y(); t.velocity[2] = v.Z();
	t.angular[0] = w.X(); t.angular[1] = w.Y(); t.angular[2] = w.Z();
	const Maths::HVec3 gv( car.GroundVelocity() );
	t.speed = Maths::Magnitude( RacingPhysics::Vector3R( v ) - RacingPhysics::Vector3R( gv ) );
	for ( int i = 0; i < 4; ++i )
	{
		const RacingPhysics::CarWheel& wheel = car.Wheel( i );
		t.wheelOnGround[i] = wheel.OnGround();
		t.suspension[i] = wheel.OnGround() ? wheel.SuspensionDistance() : 0.0f;
		const Maths::C_Vertex& wp = wheel.GetWheelPosition();
		t.wheelPosition[i][0] = wp.X(); t.wheelPosition[i][1] = wp.Y(); t.wheelPosition[i][2] = wp.Z();
		t.wheelAngular[i] = wheel.GetAngularVelocity1D();
		t.surfaceFlags[i] = wheel.OnGround() ? wheel.SurfaceType() : 0xffffffffu;
		t.userData[i] = wheel.OnGround() ? wheel.UserData() : 0xffffffffu;
		if ( wheel.OnGround() )
		{
			const Maths::C_Normal& n = wheel.GroundNormal();
			t.groundNormal[i][0] = n.X(); t.groundNormal[i][1] = n.Y(); t.groundNormal[i][2] = n.Z();
		}
		else
		{
			t.groundNormal[i][0] = t.groundNormal[i][1] = t.groundNormal[i][2] = 0.0f;
		}
	}
}

// canonical per-tick bytes: fixed field order, floats as their binary32 bits
struct TickBytes
{
	unsigned char b[4 + 3 * 4 + 9 * 4 + 3 * 4 + 3 * 4 + 4 + 4 * ( 4 + 12 + 1 ) + 4 * 4 + 4 * 12];
	size_t n;

	TickBytes() : n( 0 ) {}
	void putU32( unsigned v ) { std::memcpy( b + n, &v, 4 ); n += 4; }
	void putF32( float v ) { unsigned u; std::memcpy( &u, &v, 4 ); putU32( u ); }
	void putFloats( const float* v, int c ) { for ( int i = 0; i < c; ++i ) putF32( v[i] ); }
};

static void Canonical( const TickState& t, unsigned index, TickBytes& o )
{
	o.n = 0;
	o.putU32( index );
	o.putFloats( t.position, 3 );
	o.putFloats( t.axisX, 3 );
	o.putFloats( t.axisY, 3 );
	o.putFloats( t.axisZ, 3 );
	o.putFloats( t.velocity, 3 );
	o.putFloats( t.angular, 3 );
	o.putF32( t.speed );
	for ( int i = 0; i < 4; ++i )
	{
		o.putU32( t.wheelOnGround[i] ? 1u : 0u );
		o.putF32( t.suspension[i] );
		o.putFloats( t.wheelPosition[i], 3 );
		o.putF32( t.wheelAngular[i] );
		o.putU32( t.surfaceFlags[i] );
		o.putU32( t.userData[i] );
		o.putFloats( t.groundNormal[i], 3 );
	}
}

static bool AllFinite( const TickState& t )
{
	const float* groups[] = { t.position, t.axisX, t.axisY, t.axisZ, t.velocity, t.angular };
	for ( int g = 0; g < 6; ++g )
		for ( int i = 0; i < 3; ++i )
			if ( !std::isfinite( (double)groups[g][i] ) ) return false;
	if ( !std::isfinite( (double)t.speed ) ) return false;
	for ( int i = 0; i < 4; ++i )
	{
		if ( !std::isfinite( (double)t.suspension[i] ) ) return false;
		if ( !std::isfinite( (double)t.wheelAngular[i] ) ) return false;
		for ( int k = 0; k < 3; ++k )
		{
			if ( !std::isfinite( (double)t.wheelPosition[i][k] ) ) return false;
			if ( !std::isfinite( (double)t.groundNormal[i][k] ) ) return false;
		}
	}
	return true;
}

// ----------------------------------------------------------------------- main

struct RunResult
{
	bool ok;
	char error[256];
};

static const int kMaxTicks = 4096;

} // namespace spike

// ---------------------------------------------------------------------------
// CarDynamicsXt field list. Each call checks the name, so a reordered or
// renamed field in the generated list is a hard failure, not a silent shift.
// Generated once from the RP_CarDynamics schema in
// gamedata\xt\racingphysics.bin (see engine/verify_vehicle.py) and reviewed;
// the names are exactly carsettings.h's member names.
// ---------------------------------------------------------------------------
#define FIELD( name, member ) \
	if ( !f.f32( name, dyn.member ) ) return false

static int Fail( spike::Fields& f, spike::Out& out, const char* where )
{
	out.raw( "{\"status\":\"error\",\"stage\":\"" );
	out.raw( where );
	out.raw( "\",\"error\":" );
	out.str( f.failed ? f.err : "field list incomplete" );
	out.raw( "}" );
	return 1;
}

struct CarBuffers
{
	float torque[32];
	float gears[32];
	float frontGear[32];
	float rearGear[32];
	RacingPhysics::LinearGraphXt::Point frontGrip[32];
	RacingPhysics::LinearGraphXt::Point rearGrip[32];
};

static bool ReadCarFields( spike::Fields& f, RacingPhysics::CarDynamicsXt& dyn, CarBuffers& buf,
                           char* nameOut, size_t nameCap, int& physicsParametersHandleOut )
{
	int n = 0;
	if ( !f.text_value( "record.name", nameOut, nameCap ) ) return false;
	if ( !f.i32( "record.physicsParametersHandle", physicsParametersHandleOut ) ) return false;
	if ( !f.f32( "mass.mass", dyn.mass.mass ) ) return false;
	if ( !f.f32( "mass.MIScaleX", dyn.mass.MIScaleX ) ) return false;
	if ( !f.f32( "mass.MIScaleY", dyn.mass.MIScaleY ) ) return false;
	if ( !f.f32( "mass.MIScaleZ", dyn.mass.MIScaleZ ) ) return false;
	if ( !f.f32( "mass.cofGOffsetY", dyn.mass.cofGOffsetY ) ) return false;
	if ( !f.f32( "mass.cofGOffsetZ", dyn.mass.cofGOffsetZ ) ) return false;
	if ( !f.f32( "mass.frontWheelMI", dyn.mass.frontWheelMI ) ) return false;
	if ( !f.f32( "mass.rearWheelMI", dyn.mass.rearWheelMI ) ) return false;
	if ( !f.f32( "mass.physicsCofMassOffsetY", dyn.mass.physicsCofMassOffsetY ) ) return false;
	if ( !f.f32( "mass.physicsCofMassOffsetZ", dyn.mass.physicsCofMassOffsetZ ) ) return false;
	if ( !f.f32( "mass.interiaTensorScaleX", dyn.mass.interiaTensorScaleX ) ) return false;
	if ( !f.f32( "mass.interiaTensorScaleY", dyn.mass.interiaTensorScaleY ) ) return false;
	if ( !f.f32( "mass.interiaTensorScaleZ", dyn.mass.interiaTensorScaleZ ) ) return false;
	// RP_LinearGraph stores its curve under the XT name "data" (the C++ member is
	// dataPoints).
	// mass.physicsParameters is an XtHandle to another record; the verifier
	// writes "0" for the null handle and aborts the run otherwise.
	if ( !f.i32( "mass.physicsParameters", n ) ) return false;
	if ( n != 0 ) return f.note( "line %d: '%s' must be the null handle", "mass.physicsParameters", n );
	if ( !f.f32( "geometry.wheelBase", dyn.geometry.wheelBase ) ) return false;
	if ( !f.f32( "geometry.trackWidthFront", dyn.geometry.trackWidthFront ) ) return false;
	if ( !f.f32( "geometry.trackWidthRear", dyn.geometry.trackWidthRear ) ) return false;

	FIELD( "suspension.front.casterAngle", suspension.front.casterAngle );
	FIELD( "suspension.front.camberAngle", suspension.front.camberAngle );
	FIELD( "suspension.front.toeAngle", suspension.front.toeAngle );
	FIELD( "suspension.front.movementDown", suspension.front.movementDown );
	FIELD( "suspension.front.movementUp", suspension.front.movementUp );
	FIELD( "suspension.front.springStiffness", suspension.front.springStiffness );
	FIELD( "suspension.front.springProgression", suspension.front.springProgression );
	FIELD( "suspension.front.springDampingCompress", suspension.front.springDampingCompress );
	FIELD( "suspension.front.springDampingRelease", suspension.front.springDampingRelease );
	FIELD( "suspension.front.rollStiffness", suspension.front.rollStiffness );
	FIELD( "suspension.rear.casterAngle", suspension.rear.casterAngle );
	FIELD( "suspension.rear.camberAngle", suspension.rear.camberAngle );
	FIELD( "suspension.rear.toeAngle", suspension.rear.toeAngle );
	FIELD( "suspension.rear.movementDown", suspension.rear.movementDown );
	FIELD( "suspension.rear.movementUp", suspension.rear.movementUp );
	FIELD( "suspension.rear.springStiffness", suspension.rear.springStiffness );
	FIELD( "suspension.rear.springProgression", suspension.rear.springProgression );
	FIELD( "suspension.rear.springDampingCompress", suspension.rear.springDampingCompress );
	FIELD( "suspension.rear.springDampingRelease", suspension.rear.springDampingRelease );
	FIELD( "suspension.rear.rollStiffness", suspension.rear.rollStiffness );

	FIELD( "steering.steerLimit", steering.steerLimit );
	FIELD( "steering.ackerman", steering.ackerman );
	FIELD( "steering.steerSmoothTime", steering.steerSmoothTime );
	FIELD( "steering.steerDirect", steering.steerDirect );
	FIELD( "steering.steerDamping", steering.steerDamping );
	FIELD( "steering.reverseSteerDamping", steering.reverseSteerDamping );
	FIELD( "steering.steerSpringDrift", steering.steerSpringDrift );
	FIELD( "steering.steerSpringCentre", steering.steerSpringCentre );
	FIELD( "steering.steerSpringLowSpeed", steering.steerSpringLowSpeed );
	FIELD( "steering.slideRecovery", steering.slideRecovery );
	FIELD( "steering.antiflick", steering.antiFlick );
	FIELD( "steering.antiflickThreshold", steering.antiFlickThreshold );

	FIELD( "brakes.frontBrakeForce", brakes.frontBrakeForce );
	FIELD( "brakes.rearBrakeForce", brakes.rearBrakeForce );
	FIELD( "brakes.handbrakeForce", brakes.handbrakeForce );
	FIELD( "brakes.brakeSmoothTime", brakes.brakeSmoothTime );
	FIELD( "brakes.handbrakeSmoothTime", brakes.handbrakeSmoothTime );

	FIELD( "engine.engineTorque_Rpm.x0", engine.engineTorque_Rpm.x0 );
	FIELD( "engine.engineTorque_Rpm.x1", engine.engineTorque_Rpm.x1 );
	FIELD( "engine.engineTorque_Rpm.yScale", engine.engineTorque_Rpm.yScale );
	if ( !f.f32Array( "engine.engineTorque_Rpm.dataPoints", dyn.engine.engineTorque_Rpm.dataPoints,
	                  buf.torque, 32, n ) ) return false;
	if ( !f.f32( "engine.engineInertia", dyn.engine.engineInertia ) ) return false;
	if ( !f.f32( "engine.limiterRPM", dyn.engine.limiterRPM ) ) return false;
	if ( !f.f32( "engine.clutchRPMFraction", dyn.engine.clutchRPMFraction ) ) return false;
	if ( !f.f32( "engine.clutchRPMFractionReverse", dyn.engine.clutchRPMFractionReverse ) ) return false;
	if ( !f.f32( "engine.idleRPM", dyn.engine.idleRPM ) ) return false;
	if ( !f.f32( "engine.powerCutFraction", dyn.engine.powerCutFraction ) ) return false;
	if ( !f.f32( "engine.engineBraking_RpmFraction.x0", dyn.engine.engineBraking_RpmFraction.x0 ) ) return false;
	if ( !f.f32( "engine.engineBraking_RpmFraction.y0", dyn.engine.engineBraking_RpmFraction.y0 ) ) return false;
	if ( !f.f32( "engine.engineBraking_RpmFraction.x1", dyn.engine.engineBraking_RpmFraction.x1 ) ) return false;
	if ( !f.f32( "engine.engineBraking_RpmFraction.y1", dyn.engine.engineBraking_RpmFraction.y1 ) ) return false;
	if ( !f.f32( "engine.clutchSmoothTime", dyn.engine.clutchSmoothTime ) ) return false;
	if ( !f.f32( "engine.clutchDelay", dyn.engine.clutchDelay ) ) return false;
	if ( !f.f32( "engine.throttleSmoothTime", dyn.engine.throttleSmoothTime ) ) return false;
	if ( !f.f32( "engine.tractionControlMaxSpin", dyn.engine.tractionControlMaxSpin ) ) return false;
	if ( !f.f32( "engine.tractionControlMaxSlip", dyn.engine.tractionControlMaxSlip ) ) return false;
	if ( !f.f32( "engine.wheelSpinMaxSpeed_Mph", dyn.engine.wheelSpinMaxSpeed_Mph ) ) return false;
	if ( !f.boolean( "engine.transverse", dyn.engine.transverse ) ) return false;

	if ( !f.i32( "transmission.driveType", n ) ) return false;
	dyn.transmission.driveType = (RacingPhysics::CarDynamicsXt::CarDriveTypeXt)n;
	if ( !f.i32( "transmission.frontDifferential.differentialType", n ) ) return false;
	dyn.transmission.frontDifferential.differentialType = (RacingPhysics::CarDynamicsXt::CarDifferentialTypeXt)n;
	FIELD( "transmission.frontDifferential.forwardsTorque", transmission.frontDifferential.forwardsTorque );
	FIELD( "transmission.frontDifferential.backwardsTorque", transmission.frontDifferential.backwardsTorque );
	FIELD( "transmission.frontDifferential.viscosity", transmission.frontDifferential.viscosity );
	if ( !f.i32( "transmission.rearDifferential.differentialType", n ) ) return false;
	dyn.transmission.rearDifferential.differentialType = (RacingPhysics::CarDynamicsXt::CarDifferentialTypeXt)n;
	FIELD( "transmission.rearDifferential.forwardsTorque", transmission.rearDifferential.forwardsTorque );
	FIELD( "transmission.rearDifferential.backwardsTorque", transmission.rearDifferential.backwardsTorque );
	FIELD( "transmission.rearDifferential.viscosity", transmission.rearDifferential.viscosity );
	if ( !f.i32( "transmission.midDifferential.differentialType", n ) ) return false;
	dyn.transmission.midDifferential.differentialType = (RacingPhysics::CarDynamicsXt::CarDifferentialTypeXt)n;
	FIELD( "transmission.midDifferential.forwardsTorque", transmission.midDifferential.forwardsTorque );
	FIELD( "transmission.midDifferential.backwardsTorque", transmission.midDifferential.backwardsTorque );
	FIELD( "transmission.midDifferential.viscosity", transmission.midDifferential.viscosity );

	if ( !f.f32Array( "gears.gearRatios", dyn.gears.gearRatios, buf.gears, 32, n ) ) return false;
	FIELD( "gears.reverseGearRatio", gears.reverseGearRatio );
	if ( !f.i32( "gears.topGear", dyn.gears.topGear ) ) return false;
	FIELD( "gears.finalRatio", gears.finalRatio );
	FIELD( "gears.gearDownRPMFraction", gears.gearDownRPMFraction );
	FIELD( "gears.maxSpeedForChangeToFirst_Mph", gears.maxSpeedForChangeToFirst_Mph );
	FIELD( "gears.maxSpeedForReverse_Mph", gears.maxSpeedForReverse_Mph );

	FIELD( "tyres.frontTyres.radius", tyres.frontTyres.radius );
	FIELD( "tyres.frontTyres.grip.yScale", tyres.frontTyres.grip.yScale );
	if ( !f.pointArray( "tyres.frontTyres.grip.data", dyn.tyres.frontTyres.grip.dataPoints,
	                    buf.frontGrip, 32, n ) ) return false;
	FIELD( "tyres.frontTyres.loadDependence", tyres.frontTyres.loadDependence );
	FIELD( "tyres.frontTyres.transverseGripScale", tyres.frontTyres.transverseGripScale );
	FIELD( "tyres.frontTyres.forwardsGripScale", tyres.frontTyres.forwardsGripScale );
	FIELD( "tyres.frontTyres.backwardsGripScale", tyres.frontTyres.backwardsGripScale );
	FIELD( "tyres.frontTyres.transverseTyreSlipScale", tyres.frontTyres.transverseTyreSlipScale );
	FIELD( "tyres.frontTyres.longitudinalTyreSlipScale", tyres.frontTyres.longitudinalTyreSlipScale );
	FIELD( "tyres.frontTyres.combinedSlipForwards_Mph.x0", tyres.frontTyres.combinedSlipForwards_Mph.x0 );
	FIELD( "tyres.frontTyres.combinedSlipForwards_Mph.y0", tyres.frontTyres.combinedSlipForwards_Mph.y0 );
	FIELD( "tyres.frontTyres.combinedSlipForwards_Mph.x1", tyres.frontTyres.combinedSlipForwards_Mph.x1 );
	FIELD( "tyres.frontTyres.combinedSlipForwards_Mph.y1", tyres.frontTyres.combinedSlipForwards_Mph.y1 );
	FIELD( "tyres.frontTyres.combinedSlipBackwards", tyres.frontTyres.combinedSlipBackwards );
	FIELD( "tyres.frontTyres.slipAlignment_Av.x0", tyres.frontTyres.slipAlignment_Av.x0 );
	FIELD( "tyres.frontTyres.slipAlignment_Av.y0", tyres.frontTyres.slipAlignment_Av.y0 );
	FIELD( "tyres.frontTyres.slipAlignment_Av.x1", tyres.frontTyres.slipAlignment_Av.x1 );
	FIELD( "tyres.frontTyres.slipAlignment_Av.y1", tyres.frontTyres.slipAlignment_Av.y1 );
	FIELD( "tyres.frontTyres.dynamicFrictionSpeed", tyres.frontTyres.dynamicFrictionSpeed );
	FIELD( "tyres.frontTyres.slipSpeed", tyres.frontTyres.slipSpeed );
	FIELD( "tyres.frontTyres.slipSmoothTimeInForwards", tyres.frontTyres.slipSmoothTimeInForwards );
	FIELD( "tyres.frontTyres.slipSmoothTimeOutForwards", tyres.frontTyres.slipSmoothTimeOutForwards );
	FIELD( "tyres.frontTyres.slipSmoothTimeInBackwards", tyres.frontTyres.slipSmoothTimeInBackwards );
	FIELD( "tyres.frontTyres.slipSmoothTimeOutBackwards", tyres.frontTyres.slipSmoothTimeOutBackwards );
	if ( !f.f32Array( "tyres.frontTyres.forwardsGripScaleInGear", dyn.tyres.frontTyres.forwardsGripScaleInGear,
	                  buf.frontGear, 32, n ) ) return false;

	FIELD( "tyres.rearTyres.radius", tyres.rearTyres.radius );
	FIELD( "tyres.rearTyres.grip.yScale", tyres.rearTyres.grip.yScale );
	if ( !f.pointArray( "tyres.rearTyres.grip.data", dyn.tyres.rearTyres.grip.dataPoints,
	                    buf.rearGrip, 32, n ) ) return false;
	FIELD( "tyres.rearTyres.loadDependence", tyres.rearTyres.loadDependence );
	FIELD( "tyres.rearTyres.transverseGripScale", tyres.rearTyres.transverseGripScale );
	FIELD( "tyres.rearTyres.forwardsGripScale", tyres.rearTyres.forwardsGripScale );
	FIELD( "tyres.rearTyres.backwardsGripScale", tyres.rearTyres.backwardsGripScale );
	FIELD( "tyres.rearTyres.transverseTyreSlipScale", tyres.rearTyres.transverseTyreSlipScale );
	FIELD( "tyres.rearTyres.longitudinalTyreSlipScale", tyres.rearTyres.longitudinalTyreSlipScale );
	FIELD( "tyres.rearTyres.combinedSlipForwards_Mph.x0", tyres.rearTyres.combinedSlipForwards_Mph.x0 );
	FIELD( "tyres.rearTyres.combinedSlipForwards_Mph.y0", tyres.rearTyres.combinedSlipForwards_Mph.y0 );
	FIELD( "tyres.rearTyres.combinedSlipForwards_Mph.x1", tyres.rearTyres.combinedSlipForwards_Mph.x1 );
	FIELD( "tyres.rearTyres.combinedSlipForwards_Mph.y1", tyres.rearTyres.combinedSlipForwards_Mph.y1 );
	FIELD( "tyres.rearTyres.combinedSlipBackwards", tyres.rearTyres.combinedSlipBackwards );
	FIELD( "tyres.rearTyres.slipAlignment_Av.x0", tyres.rearTyres.slipAlignment_Av.x0 );
	FIELD( "tyres.rearTyres.slipAlignment_Av.y0", tyres.rearTyres.slipAlignment_Av.y0 );
	FIELD( "tyres.rearTyres.slipAlignment_Av.x1", tyres.rearTyres.slipAlignment_Av.x1 );
	FIELD( "tyres.rearTyres.slipAlignment_Av.y1", tyres.rearTyres.slipAlignment_Av.y1 );
	FIELD( "tyres.rearTyres.dynamicFrictionSpeed", tyres.rearTyres.dynamicFrictionSpeed );
	FIELD( "tyres.rearTyres.slipSpeed", tyres.rearTyres.slipSpeed );
	FIELD( "tyres.rearTyres.slipSmoothTimeInForwards", tyres.rearTyres.slipSmoothTimeInForwards );
	FIELD( "tyres.rearTyres.slipSmoothTimeOutForwards", tyres.rearTyres.slipSmoothTimeOutForwards );
	FIELD( "tyres.rearTyres.slipSmoothTimeInBackwards", tyres.rearTyres.slipSmoothTimeInBackwards );
	FIELD( "tyres.rearTyres.slipSmoothTimeOutBackwards", tyres.rearTyres.slipSmoothTimeOutBackwards );
	if ( !f.f32Array( "tyres.rearTyres.forwardsGripScaleInGear", dyn.tyres.rearTyres.forwardsGripScaleInGear,
	                  buf.rearGear, 32, n ) ) return false;

	FIELD( "friction.airFriction", friction.airFriction );
	FIELD( "friction.rollingFriction", friction.rollingFriction );
	FIELD( "friction.constantDownforce", friction.constantDownforce );
	FIELD( "friction.downforce", friction.downforce );
	FIELD( "friction.downforceOffset", friction.downforceOffset );
	FIELD( "friction.rotationalAirFriction", friction.rotationalAirFriction );
	return true;
}

#undef FIELD

// ---------------------------------------------------------------------------

extern "C" __attribute__( ( visibility( "default" ) ) )
char* vehicle_run( const char* levelData, int levelLen, const char* fieldData, int fieldLen,
                   float startX, float startZ, int settleTicks, int driveTicks, float throttle,
                   float steer, float dt )
{
	using namespace spike;

	static char s_out[32u * 1024u * 1024u];
	Out out( s_out, sizeof s_out );

	// ---- car dynamics -----------------------------------------------------
	CarBuffers buffers;
	RacingPhysics::CarDynamicsXt dyn;
	char carName[128] = { 0 };
	int physicsParametersHandle = 0;
	Fields fields( fieldData, (size_t)fieldLen );
	if ( !ReadCarFields( fields, dyn, buffers, carName, sizeof carName, physicsParametersHandle ) )
		return ( Fail( fields, out, "car_field" ), s_out );

	// The whole record must be consumed: an extra line means the generator and
	// this list disagree.
	{
		char key[128];
		const char* v = 0;
		if ( fields.next( key, sizeof key, &v ) )
			return ( fields.note( "line %d: trailing entry '%s'", key, fields.line ),
			         Fail( fields, out, "car_field_trailing" ), s_out );
	}

	// ---- platform / structure checks --------------------------------------
	const unsigned sizeofCar = (unsigned)sizeof( RacingPhysics::CarDynamicsXt );
	const unsigned offName = (unsigned)offsetof( RacingPhysics::CarDynamicsXt, name );
	const unsigned offMass = (unsigned)offsetof( RacingPhysics::CarDynamicsXt, mass );
	const unsigned offGeometry = (unsigned)offsetof( RacingPhysics::CarDynamicsXt, geometry );
	const unsigned offGrip = (unsigned)offsetof( RacingPhysics::CarDynamicsXt, tyres.frontTyres.grip );
	const unsigned offFriction = (unsigned)offsetof( RacingPhysics::CarDynamicsXt, friction );
	const unsigned offGearRatios = (unsigned)offsetof( RacingPhysics::CarDynamicsXt, gears.gearRatios );
	const unsigned offTorque = (unsigned)offsetof( RacingPhysics::CarDynamicsXt, engine.engineTorque_Rpm );

	// ---- level ------------------------------------------------------------
	{
		unsigned mainOffset = 0, mainLen = 0;
		const char* why = "";
		if ( !FindMainBlock( (const unsigned char*)levelData, (size_t)levelLen, mainOffset, mainLen, why ) )
		{
			out.raw( "{\"status\":\"error\",\"stage\":\"level_block\",\"error\":" );
			out.str( why );
			out.raw( "}" );
			return s_out;
		}

		// ---- scheduler: the same order the game uses (SchedulerConfig.cpp) --
		// GameWorld.cpp:561 installs C_SchedulerConfig's collision/physics policy on
		// the scene; SchedulerConfig.cpp:24 defines it as {7,7,7,7,7,7,7,7}.
		static const Scheduler::Policy scenePolicy[8] = { 7, 7, 7, 7, 7, 7, 7, 7 };
		Scheduler::PolicyHandle policy = Scheduler::CreatePolicy( scenePolicy );
		Scheduler::Init();
		Scheduler::Start();
		Scheduler::SetGroupPoolSize( 16 );

		// ---- scene --------------------------------------------------------
		static MaterialMatrix materials;
		Gravity::C_PhysicsSDK* sdk = Gravity::C_PhysicsSDK::PhysicsSDK();
		Gravity::C_Scene* scene = sdk->CreateScene( &materials.pair, 1 );
		scene->SetInternalTaskPolicy( policy );

		Sys::C_MemoryStream stream( (U8*)( levelData + mainOffset + 16 ), (U32)( mainLen - 16 ) );
		Gravity::C_ImportScene* importScene = sdk->CreateImportScene();
		if ( !importScene->Import( &stream ) )
		{
			out.raw( "{\"status\":\"error\",\"stage\":\"import_scene\",\"error\":\"C_ImportScene::Import returned false\"}" );
			return s_out;
		}

		Collision::C_CollisionFilter filter;
		{
			// GameResource::C_LevelInstance: desiredSize (5,20,5), maxCellSize (50,50,50)
			Gravity::C_ImportSceneStaticInstance instance(
				scene, importScene, Maths::HVec3( 5.f, 20.f, 5.f ), Maths::HVec3( 50.f, 50.f, 50.f ),
				&filter, &filter );

			const int numMeshBodies = (int)importScene->m_StaticInstance.m_numElements;

			unsigned groundProbeCached = 0;

			// C_Scene::AddMeshBody queues a deferred command, so the mesh bodies only
			// enter m_MeshCollisionBodies when the scene processes its command queue
			// (inside the first _Simulate). The level load has no tick of its own, so
			// drain the queue here before asking the scene for ground.
			scene->ProcessCommands();
			float groundY = 0.0f;
			{
				void* data[512];
				SharedPhysics::C_SafeStack<true> stack( data, 512 );
				Collision::C_LineCollisionCache cache( 128 );
				// One tall, narrow column over the start point. FillCache keeps at most
				// four triangles, so a column wider than the wheel contact patch would
				// risk losing the road surface.
				const float probeTop = 130.0f;
				const float probeHalfHeight = 150.0f;
				Collision::C_CRAxisBox box;
				box.centre = Maths::HVec3( startX, probeTop - probeHalfHeight, startZ );
				box.extents = Maths::HVec3( 1.0f, probeHalfHeight, 1.0f );
				const Maths::C_Normal down( Maths::Constants<Maths::HVec3>::UnitAxisNegativeY(),
				                            Maths::C_Normal::UNIT_LENGTH_VECTOR );
				cache.Reset();
				scene->FillCache( box, cache, stack, &filter, down,
				                  Maths::HF32( -Maths::Constants<Maths::HF32>::Quarter() ) );
				Collision::C_Ray ray;
				ray.InitialiseRay( Maths::C_Vertex( startX, probeTop, startZ ), down, 400.f, &filter, 0.f );
				ray.SetMaxCosAngle( -Maths::Constants<Maths::HF32>::Quarter() );
				Collision::C_SingleTriangleCache tri;
				cache.Trace( ray, &tri );
				if ( ray.m_result.m_pShape == NULL )
				{
					out.raw( "{\"status\":\"error\",\"stage\":\"ground_probe\",\"error\":\"no ground under the start point\",\"cachedTriangles\":" );
					out.u32( cache.m_High - cache.m_Low );
					out.raw( ",\"staticInstances\":" ); out.u32( (unsigned)importScene->m_StaticInstance.m_numElements );
					out.raw( ",\"staticShapeDescs\":" ); out.u32( (unsigned)importScene->m_StaticShapesDesc.m_numElements );
					out.raw( ",\"dynamicShapes\":" ); out.u32( (unsigned)importScene->m_DynamicShapes.m_numElements );
					out.raw( ",\"cached\":[" );
					for ( U32 t = cache.m_Low; t < cache.m_High; ++t )
					{
						if ( t > cache.m_Low ) out.ch( ',' );
						const Collision::C_CachedTriangle& ct = cache.m_pTriangles[t];
						out.ch( '[' );
						out.bits( ct.m_VertexA.X() ); out.ch( ',' ); out.bits( ct.m_VertexA.Y() ); out.ch( ',' ); out.bits( ct.m_VertexA.Z() ); out.ch( ',' );
						out.bits( ct.m_VertexB.X() ); out.ch( ',' ); out.bits( ct.m_VertexB.Y() ); out.ch( ',' ); out.bits( ct.m_VertexB.Z() ); out.ch( ',' );
						out.bits( ct.m_VertexC.X() ); out.ch( ',' ); out.bits( ct.m_VertexC.Y() ); out.ch( ',' ); out.bits( ct.m_VertexC.Z() ); out.ch( ',' );
						out.bits( ct.m_Normal.X() ); out.ch( ',' ); out.bits( ct.m_Normal.Y() ); out.ch( ',' ); out.bits( ct.m_Normal.Z() );
						out.ch( ']' );
					}
					out.raw( "]" );
					out.raw( ",\"sceneBounds\":[" );
					{
						Collision::C_AxisBoxMinMax wb = scene->GetWorldBounds();
						out.bits( wb.m_min.X() ); out.ch( ',' ); out.bits( wb.m_min.Y() ); out.ch( ',' );
						out.bits( wb.m_min.Z() ); out.ch( ',' ); out.bits( wb.m_max.X() ); out.ch( ',' );
						out.bits( wb.m_max.Y() ); out.ch( ',' ); out.bits( wb.m_max.Z() );
					}
					out.raw( "]}" );
					return s_out;
				}
				groundY = ray.m_result.m_contact.Y();
				groundProbeCached = cache.m_High - cache.m_Low;
			}

			// ---- car ------------------------------------------------------
			static RacingPhysics::Car car;
			car.SetWebCarDynamics( &dyn );

			RacingPhysics::VehicleInitialiseInfo info;
			info.folder = "";
			info.filename = carName;
			info.vehicleIndex = 0;
			info.controlType = RacingPhysics::Vehicle::CONTROL_TYPE_PLAYER;
			info.controllerPort = -1;
			info.autoGears = true;
			info.autoReverse = true;
			info.forceHandbrake = false;
			info.vehicleToVehicleCollisions = false;
			car.Initialise( info );
			car.SetGravityScene( scene );

			const float rideHeight = dyn.tyres.frontTyres.radius + dyn.suspension.front.movementUp;
			const float startY = groundY + rideHeight;

			Maths::HMat33 identity( Maths::Constants<Maths::HMat33>::Identity() );
			Maths::HVec3 position( startX, startY, startZ );
			Gravity::C_Body* body = scene->CreateBody();
			{
				Gravity::C_BoxDesc boxDesc;
				boxDesc.m_HalfExtents = Maths::HVec3( dyn.geometry.trackWidthFront * 0.5f,
				                                      dyn.tyres.frontTyres.radius,
				                                      dyn.geometry.wheelBase * 0.5f );
				boxDesc.m_PhysicsMaterialIndex = 0;
				boxDesc.m_EffectMaterialIndex = 0;
				Gravity::C_BodyHelper helper( &boxDesc );
				helper.CreateBody( Maths::HF32( dyn.mass.mass ), position, identity, body, &filter );
			}
			auto gravityConstants = new Gravity::C_ExternalConstants();
			{
				// VehicleActor.cpp:6907-6913: the game's own vehicle defaults.
				gravityConstants->m_Gravity = Maths::HVec3( 0.f, -9.8f, 0.f );
			}
			body->SetExternalConstants( gravityConstants );
			body->Baumgarte( 1.25f );
			body->Slop( 0.00005f );
			body->SetMaxAngularVelocity( 10.0f );
			body->SetMaxLinearVelocity( 250.0f * ( 1609.f / 3600.f ) );
			{
				SharedPhysics::C_Deactivator deactivator;
				deactivator.m_ActivateThresholdSq = -1.f;
				deactivator.m_SleepThresholdSq = -1.f;
				deactivator.m_sSleepCountdown = 15;
				body->SetDeactivator( deactivator );
			}

			const Maths::HVec3 bounds( dyn.geometry.trackWidthFront * 0.5f,
			                           dyn.tyres.frontTyres.radius,
			                           dyn.geometry.wheelBase * 0.5f );
			car.SetGravityBody( body, Maths::HVec3( 0.f, 0.f, 0.f ), bounds, Maths::HVec3( 0.f, 0.f, 0.f ) );

			RacingPhysics::Axis axis;
			axis.SetIdentityMatrix();
			axis.SetPosition( RacingPhysics::Point3R( startX, startY, startZ ) );
			car.SetAxis( axis );

			scene->AddBody( body );
			scene->SetMinTimeStep( Maths::HF32( -1.f ) ); // GameWorld.cpp:2569

			RacingPhysics::PhysicsTimer::Instance().InitialiseTimers();
			RacingPhysics::PhysicsTimer::Instance().SetPhysicsUpdateTime( dt );

			// ---- run ------------------------------------------------------
			TickState state;
			TickBytes canonical;
			Sha256 settleHash, driveHash, allHash;
			unsigned long long settleTicksSeen = 0, driveTicksSeen = 0;
			unsigned contactTicks = 0, nanTicks = 0;
			float maxSettleSpeed = 0.0f;
			float drivenDistance = 0.0f;
			float firstDrivePosition[3] = { 0, 0, 0 };
			float lastDrivePosition[3] = { 0, 0, 0 };

			out.raw( "{\"status\":\"ok\"" );
			out.raw( ",\"build\":{" );
			out.key( "platform" );
#if defined( __wasm32__ )
			out.str( "wasm32-unknown-emscripten" );
#elif defined( _MSC_VER )
			out.str( "native-msvc" );
#else
			out.str( "native" );
#endif
			out.raw( ",\"sizeofCarDynamicsXt\":" ); out.u32( sizeofCar );
			out.raw( ",\"offsetof\":{" );
			out.key( "name" ); out.u32( offName );
			out.raw( ",\"mass\":" ); out.u32( offMass );
			out.raw( ",\"geometry\":" ); out.u32( offGeometry );
			out.raw( ",\"tyreGrip\":" ); out.u32( offGrip );
			out.raw( ",\"gearRatios\":" ); out.u32( offGearRatios );
			out.raw( ",\"torqueCurve\":" ); out.u32( offTorque );
			out.raw( ",\"friction\":" ); out.u32( offFriction );
			out.raw( "},\"carFieldLines\":" ); out.u32( (unsigned)fields.line );
			out.raw( ",\"sizeofCar\":" ); out.u32( (unsigned)sizeof( RacingPhysics::Car ) );
			out.raw( "}" );

			out.raw( ",\"scenario\":{" );
			out.key( "car" ); out.str( carName );
			out.raw( ",\"physicsParametersHandle\":" ); out.u32( (unsigned)physicsParametersHandle );
			out.raw( ",\"startX\":" ); out.bits( startX );
			out.raw( ",\"startZ\":" ); out.bits( startZ );
			out.raw( ",\"groundY\":" ); out.bits( groundY );
			out.raw( ",\"startY\":" ); out.bits( startY );
			out.raw( ",\"dt\":" ); out.bits( dt );
			out.raw( ",\"settleTicks\":" ); out.i32( settleTicks );
			out.raw( ",\"driveTicks\":" ); out.i32( driveTicks );
			out.raw( ",\"throttle\":" ); out.bits( throttle );
			out.raw( ",\"steer\":" ); out.bits( steer );
			out.raw( ",\"meshBodies\":" ); out.i32( numMeshBodies );
			out.raw( ",\"mass\":" ); out.bits( dyn.mass.mass );
			out.raw( ",\"rideHeight\":" ); out.bits( rideHeight );
			out.raw( "}" );

			out.raw( ",\"ticks\":[" );
			bool firstTick = true;
			const int total = settleTicks + driveTicks;
			for ( int tick = 0; tick < total; ++tick )
			{
				const bool driving = tick >= settleTicks;
				RacingPhysics::CarControls& controls = car.Controls();
				controls.Clear();
				if ( driving )
				{
					controls.throttle = throttle;
					controls.steer = steer;
				}
				car.DriverSettings().autoGears = true;
				car.DriverSettings().tractionControl = true;
				car.DriverSettings().ABS = true;

				scene->Simulate( Maths::C_TimeS( dt ) );
				RacingPhysics::PhysicsTimer::Instance().UpdatePhysicsTimer();

				SampleCar( car, state );
				Canonical( state, (unsigned)tick, canonical );
				const unsigned long long tickHash = Fnv64( canonical.b, canonical.n );
				const bool finite = AllFinite( state );
				if ( !finite ) ++nanTicks;
				allHash.update( canonical.b, canonical.n );
				if ( driving )
				{
					driveHash.update( canonical.b, canonical.n );
					++driveTicksSeen;
					if ( driveTicksSeen == 1 )
					{
						std::memcpy( firstDrivePosition, state.position, sizeof firstDrivePosition );
					}
					std::memcpy( lastDrivePosition, state.position, sizeof lastDrivePosition );
				}
				else
				{
					settleHash.update( canonical.b, canonical.n );
					++settleTicksSeen;
					if ( state.speed > maxSettleSpeed ) maxSettleSpeed = state.speed;
				}
				bool anyContact = false;
				for ( int i = 0; i < 4; ++i ) anyContact |= state.wheelOnGround[i];
				if ( anyContact ) ++contactTicks;

				if ( !firstTick ) out.ch( ',' );
				firstTick = false;
				out.raw( "{\"t\":" ); out.i32( tick );
				out.raw( ",\"driving\":" ); out.i32( driving ? 1 : 0 );
				out.raw( ",\"p\":" ); out.vec( state.position, 3 );
				out.raw( ",\"ax\":" ); out.vec( state.axisX, 3 );
				out.raw( ",\"ay\":" ); out.vec( state.axisY, 3 );
				out.raw( ",\"az\":" ); out.vec( state.axisZ, 3 );
				out.raw( ",\"v\":" ); out.vec( state.velocity, 3 );
				out.raw( ",\"w\":" ); out.vec( state.angular, 3 );
				out.raw( ",\"speed\":" ); out.bits( state.speed );
				out.raw( ",\"g\":[" );
				for ( int i = 0; i < 4; ++i ) { if ( i ) out.ch( ',' ); out.i32( state.wheelOnGround[i] ? 1 : 0 ); }
				out.raw( "],\"susp\":[" );
				for ( int i = 0; i < 4; ++i ) { if ( i ) out.ch( ',' ); out.bits( state.suspension[i] ); }
				out.raw( "],\"wp\":[" );
				for ( int i = 0; i < 4; ++i )
				{
					if ( i ) out.ch( ',' );
					out.vec( state.wheelPosition[i], 3 );
				}
				out.raw( "],\"wav\":[" );
				for ( int i = 0; i < 4; ++i ) { if ( i ) out.ch( ',' ); out.bits( state.wheelAngular[i] ); }
				out.raw( "],\"surf\":[" );
				for ( int i = 0; i < 4; ++i ) { if ( i ) out.ch( ',' ); out.u32( state.surfaceFlags[i] ); }
				out.raw( "],\"ud\":[" );
				for ( int i = 0; i < 4; ++i ) { if ( i ) out.ch( ',' ); out.u32( state.userData[i] ); }
				out.raw( "],\"gn\":[" );
				for ( int i = 0; i < 4; ++i )
				{
					if ( i ) out.ch( ',' );
					out.vec( state.groundNormal[i], 3 );
				}
				out.raw( "],\"h\":" ); out.u64hex( tickHash );
				out.raw( ",\"finite\":" ); out.i32( finite ? 1 : 0 );
				out.ch( '}' );

				if ( out.overflow ) break;
			}
			out.raw( "]" );

			const float dx = lastDrivePosition[0] - firstDrivePosition[0];
			const float dz = lastDrivePosition[2] - firstDrivePosition[2];
			drivenDistance = std::sqrt( dx * dx + dz * dz );

			unsigned char allDigest[32], settleDigest[32], driveDigest[32];
			allHash.finish( allDigest );
			settleHash.finish( settleDigest );
			driveHash.finish( driveDigest );
			char allHex[65], settleHex[65], driveHex[65];
			for ( int i = 0; i < 32; ++i )
			{
				std::snprintf( allHex + i * 2, 3, "%02x", allDigest[i] );
				std::snprintf( settleHex + i * 2, 3, "%02x", settleDigest[i] );
				std::snprintf( driveHex + i * 2, 3, "%02x", driveDigest[i] );
			}

			out.raw( ",\"summary\":{" );
			out.key( "settleTicks" ); out.i32( (int)settleTicksSeen );
			out.raw( ",\"driveTicks\":" ); out.i32( (int)driveTicksSeen );
			out.raw( ",\"contactTicks\":" ); out.u32( contactTicks );
			out.raw( ",\"nanTicks\":" ); out.u32( nanTicks );
			out.raw( ",\"maxSettleSpeed\":" ); out.bits( maxSettleSpeed );
			out.raw( ",\"driveDistance\":" ); out.bits( drivenDistance );
			out.raw( ",\"finalPosition\":" ); out.vec( lastDrivePosition, 3 );
			out.raw( ",\"allStateHash\":" ); out.str( allHex );
			out.raw( ",\"settleStateHash\":" ); out.str( settleHex );
			out.raw( ",\"driveStateHash\":" ); out.str( driveHex );
			out.raw( ",\"canonicalTickBytes\":" ); out.u32( (unsigned)canonical.n );
			out.raw( ",\"overflow\":" ); out.i32( out.overflow ? 1 : 0 );
			out.raw( "}" );
			out.raw( "}" );
		}
	}

	if ( out.overflow )
	{
		char msg[96];
		std::snprintf( msg, sizeof msg, "{\"status\":\"error\",\"stage\":\"output_overflow\"}" );
		std::memcpy( s_out, msg, std::strlen( msg ) + 1 );
		return s_out;
	}
	return s_out;
}
