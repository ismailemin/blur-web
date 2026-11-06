// E1 drive slice — library wrapper around the T-005d vehicle spike.
//
// This is harness code, not engine code. It links the same 186-object closure as
// engine/harness/t005d-vehicle/vehicle_harness.cpp (23 RacingPhysics + 118
// Gravity + 44 logging/platform/maths + harness) but exposes a *library* ABI
// instead of one batch entry point:
//
//   e1_create(level, levelLen, fields, fieldsLen, startX, startZ, heading)
//   e1_reset()                       -> rebuild the world, settle, tick = 0
//   e1_set_input(throttle, brake, steer, handbrake)
//   e1_step()                        -> one C_Scene::Simulate(1/60)
//   e1_get_state()                   -> JSON snapshot of this tick
//   e1_ground_probe(x, z)            -> JSON ground query at one point
//   e1_last_error()                  -> the message when a call returned 0
//
// Nothing here integrates a body, evaluates a tyre force or casts a wheel ray:
// every force, integration step and contact is the engine's own call, exactly as
// in the verified T-005d harness. The two choices the harness makes are the same
// two the T-005d document lists: the start pose (a ground-probed point on
// usa_la_river/Level.levelphysics) and a box Gravity proxy sized from the XT
// geometry (the retail composite shape needs the model import).
//
// The box proxy's *underside* is lifted by kChassisProxyLiftMetres through the
// shape descriptor's own element offset (C_ShapeDesc::m_RenderOffset, the retail
// "element offset" mechanism in ShapeDescriptors.cpp): the box body keeps its
// mass, its inertia tensor and its centre of mass, only the collision surface
// moves up. The T-005d box was centred on the body origin with half-height equal
// to the front tyre radius, which put its lower face on the wheel-contact plane;
// every 5-10 cm collision rise (a section join, a low-poly crest) therefore struck
// the flat plate and stopped the car. The lift is measured and recorded in
// docs/work/verification/T-007-ledge-fix.md; e1_info() reports it.

#include "stdafx.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <new>

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
// path (identical to the T-005d harness; see engine-vehicle-physics.md §7.1).
// ---------------------------------------------------------------------------
XtType gXtNullType;
XtRecord gXtNullRecord;

namespace
{
	void FailFatal( const char* what )
	{
		std::fprintf( stderr, "[e1-drive] %s\n", what );
		std::fflush( stderr );
		std::abort();
	}

	void XtMissing( const char* what )
	{
		std::fprintf( stderr, "[e1-drive] xt2 runtime is not ported: %s called\n", what );
		std::fflush( stderr );
		std::abort();
	}
}

namespace RacingPhysics
{
	void WebPhysicsFatal( const char* what ) { FailFatal( what ); }
}

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

// The scheduler pool lives in jobqueue.cpp; only the diagnostics below read it.
namespace Scheduler
{
	extern TaskPool jqPool;
}

namespace e1
{

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
		if ( !failed ) { std::snprintf( err, sizeof err, fmt, a, n ); failed = true; }
		return false;
	}
	bool fail( const char* text )
	{
		if ( !failed ) { std::snprintf( err, sizeof err, "%s", text ); failed = true; }
		return false;
	}

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
			*value = text + tab + 1;
			return true;
		}
		return note( "unexpected end of field list at line %d", "", line );
	}

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

// ------------------------------------------------------------- level parsing

static bool FindMainBlock( const unsigned char* data, size_t size, unsigned& offset, unsigned& len,
                           const char*& why )
{
	if ( size < 20 || std::memcmp( data, "  CP", 4 ) != 0 ) { why = "bad_pc_marker"; return false; }
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
		if ( std::memcmp( data + p, "Main", 4 ) == 0 ) { offset = p; len = bsize; return true; }
		p += bsize;
	}
	why = "main_block_missing";
	return false;
}

// ------------------------------------------------------------------- car data

struct CarBuffers
{
	float torque[32];
	float gears[32];
	float frontGear[32];
	float rearGear[32];
	RacingPhysics::LinearGraphXt::Point frontGrip[32];
	RacingPhysics::LinearGraphXt::Point rearGrip[32];
};

} // namespace e1

// ---------------------------------------------------------------------------
// CarDynamicsXt field list, identical to engine/harness/t005d-vehicle/vehicle_harness.cpp:
// each call checks the name, so a reordered list is a hard failure.
// ---------------------------------------------------------------------------
#define FIELD( name, member ) \
	if ( !f.f32( name, dyn.member ) ) return false

static bool ReadCarFields( e1::Fields& f, RacingPhysics::CarDynamicsXt& dyn, e1::CarBuffers& buf,
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
	FIELD( "engine.engineInertia", engine.engineInertia );
	FIELD( "engine.limiterRPM", engine.limiterRPM );
	FIELD( "engine.clutchRPMFraction", engine.clutchRPMFraction );
	FIELD( "engine.clutchRPMFractionReverse", engine.clutchRPMFractionReverse );
	FIELD( "engine.idleRPM", engine.idleRPM );
	FIELD( "engine.powerCutFraction", engine.powerCutFraction );
	FIELD( "engine.engineBraking_RpmFraction.x0", engine.engineBraking_RpmFraction.x0 );
	FIELD( "engine.engineBraking_RpmFraction.y0", engine.engineBraking_RpmFraction.y0 );
	FIELD( "engine.engineBraking_RpmFraction.x1", engine.engineBraking_RpmFraction.x1 );
	FIELD( "engine.engineBraking_RpmFraction.y1", engine.engineBraking_RpmFraction.y1 );
	FIELD( "engine.clutchSmoothTime", engine.clutchSmoothTime );
	FIELD( "engine.clutchDelay", engine.clutchDelay );
	FIELD( "engine.throttleSmoothTime", engine.throttleSmoothTime );
	FIELD( "engine.tractionControlMaxSpin", engine.tractionControlMaxSpin );
	FIELD( "engine.tractionControlMaxSlip", engine.tractionControlMaxSlip );
	FIELD( "engine.wheelSpinMaxSpeed_Mph", engine.wheelSpinMaxSpeed_Mph );
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

namespace e1
{

// ------------------------------------------------------------------ the world

struct MaterialMatrix
{
	SharedPhysics::C_MaterialPair pair;
	MaterialMatrix()
	{
		// Materials.cpp:35-42 defaults; the level declares physics material 0 for
		// every shape, so one pair is the whole matrix (T-005d harness §4.1).
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
	bool finite;
	bool anyContact;
};

static const int kWarmupTicks = 180; // T-005d settle phase: 180 ticks at rest
static const float kDt = 1.0f / 60.0f;

// Chassis collision proxy: the box's lower face is raised inside the XT body by
// this many metres. See the file header. A build-time define lets the measurement
// sweep build variants; the shipped module uses the default below.
#ifndef E1_CHASSIS_PROXY_LIFT
#define E1_CHASSIS_PROXY_LIFT 0.0f
#endif
static const float kChassisProxyLiftMetres = E1_CHASSIS_PROXY_LIFT;

struct World
{
	bool created;
	bool ready;
	char error[512];

	// inputs (persisted across step calls)
	unsigned char* levelCopy;
	int levelLen;
	RacingPhysics::CarDynamicsXt dyn;
	CarBuffers buffers;
	char carName[128];
	int physicsParametersHandle;

	// pose
	float startX, startZ, heading;

	// per-reset objects
	Gravity::C_Scene* scene;
	Gravity::C_ImportScene* importScene;
	Gravity::C_ImportSceneStaticInstance* staticInstance;
	Collision::C_CollisionFilter filter;
	RacingPhysics::Car* car;
	Gravity::C_Body* body;
	// The scene's scheduler group handles. C_Scene's constructor leaves both
	// members uninitialised (Scene.cpp:133-136 creates none) and the retail game
	// assigns them from C_SchedulerConfig (GameWorld.cpp:562-563); a scene that
	// flushes an uninitialised handle reads stale heap bytes as a group index.
	Scheduler::GroupHandle group;
	Scheduler::GroupHandle broadPhaseGroup;
	float groundY;
	float startY;
	float input[4]; // throttle, brake, steer, handbrake
	int tick;
	unsigned resetCount;

	World()
		: created( false ), ready( false ), levelCopy( 0 ), levelLen( 0 ), dyn(), buffers(),
		  physicsParametersHandle( 0 ), startX( 0 ), startZ( 0 ), heading( 0 ), scene( 0 ),
		  importScene( 0 ), staticInstance( 0 ), car( 0 ), body( 0 ),
		  group( Scheduler::JQ_GROUP_NONE ), broadPhaseGroup( Scheduler::JQ_GROUP_NONE ),
		  groundY( 0 ), startY( 0 ), tick( 0 ), resetCount( 0 )
	{
		error[0] = 0;
		carName[0] = 0;
		input[0] = input[1] = input[2] = input[3] = 0;
	}
};

static World gWorld;
static char s_state[8192];
static char s_probe[2048];

static void SetError( const char* text )
{
	std::snprintf( gWorld.error, sizeof gWorld.error, "%s", text );
}

static Scheduler::PolicyHandle gScenePolicy = 0;

// ---------------------------------------------------------------------------
// Diagnostic read of the scheduler pool, used to prove what the scene's group
// handles are. `m_Group` is a C_Scene member the scene constructor does not
// initialise (the retail game sets it with SetInternalGroupHandle, GameWorld.cpp
// :562-563); the pool itself is only partly initialised by SetGroupPoolSize.
// Reading it back is the only way to tell a valid handle from stale heap bytes.
// ---------------------------------------------------------------------------

static void AppendSchedulerDiagnostics( char*& p, char* end )
{
	const ::Scheduler::TaskPool& pool = ::Scheduler::jqPool;
	int n;
	n = std::snprintf( p, (size_t)( end - p ),
	                   "\"scheduler\":{\"active\":%d,\"poolSize\":%d,\"poolHead\":%d,"
	                   "\"queued\":%d,\"executing\":%d,\"groups\":[",
	                   pool.ThisPtr ? 1 : 0, pool.BatchGroupPoolSize, pool.BatchGroupPoolHead,
	                   pool.QueuedBatchCount, pool.ExecutingBatchCount );
	if ( n > 0 ) p += n;
	const int groups = pool.BatchGroupPool ? pool.BatchGroupPoolSize : 0;
	for ( int i = 0; i < groups; ++i )
	{
		const Scheduler::TaskGroup& group = pool.BatchGroupPool[i];
		n = std::snprintf( p, (size_t)( end - p ),
		                   "%s{\"id\":%d,\"queued\":%d,\"executing\":%d,\"dependencies\":%d,"
		                   "\"next\":%d,\"event\":%u}",
		                   i ? "," : "", i, group.QueuedBatchCount, group.ExecutingBatchCount,
		                   group.NDependencies, group.Next, (unsigned)group.bUsingEvent );
		if ( n > 0 ) p += n;
	}
	n = std::snprintf( p, (size_t)( end - p ), "]}" );
	if ( n > 0 ) p += n;
}

static bool InitialiseScheduler()
{
	static bool once = false;
	if ( once ) return true;
	static const Scheduler::Policy scenePolicy[8] = { 7, 7, 7, 7, 7, 7, 7, 7 };
	gScenePolicy = Scheduler::CreatePolicy( scenePolicy );
	Scheduler::Init();
	Scheduler::Start();
	Scheduler::SetGroupPoolSize( 16 );
	once = true;
	return true;
}

static void SampleCar( RacingPhysics::Car& car, TickState& t )
{
	const Maths::C_Vertex& p = car.GetPosition();
	const Maths::HMat33 m( car.GetAxis().Matrix3() );
	const Maths::C_Vector& v = car.GetVelocity();
	const Maths::HVec3& w = car.GetAngularVelocity();
	t.position[0] = p.X(); t.position[1] = p.Y(); t.position[2] = p.Z();
	t.axisX[0] = m.AX().X(); t.axisX[1] = m.AX().Y(); t.axisX[2] = m.AX().Z();
	t.axisY[0] = m.AY().X(); t.axisY[1] = m.AY().Y(); t.axisY[2] = m.AY().Z();
	t.axisZ[0] = m.AZ().X(); t.axisZ[1] = m.AZ().Y(); t.axisZ[2] = m.AZ().Z();
	t.velocity[0] = v.X(); t.velocity[1] = v.Y(); t.velocity[2] = v.Z();
	t.angular[0] = w.X(); t.angular[1] = w.Y(); t.angular[2] = w.Z();
	const Maths::HVec3 gv( car.GroundVelocity() );
	t.speed = Maths::Magnitude( RacingPhysics::Vector3R( v ) - RacingPhysics::Vector3R( gv ) );
	t.anyContact = false;
	for ( int i = 0; i < 4; ++i )
	{
		const RacingPhysics::CarWheel& wheel = car.Wheel( i );
		t.wheelOnGround[i] = wheel.OnGround();
		if ( t.wheelOnGround[i] ) t.anyContact = true;
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
	const float* groups[] = { t.position, t.axisX, t.axisY, t.axisZ, t.velocity, t.angular };
	t.finite = true;
	for ( int g = 0; g < 6; ++g )
		for ( int k = 0; k < 3; ++k )
			if ( !std::isfinite( (double)groups[g][k] ) ) t.finite = false;
	if ( !std::isfinite( (double)t.speed ) ) t.finite = false;
	for ( int i = 0; i < 4; ++i )
	{
		if ( !std::isfinite( (double)t.suspension[i] ) ) t.finite = false;
		if ( !std::isfinite( (double)t.wheelAngular[i] ) ) t.finite = false;
		for ( int k = 0; k < 3; ++k )
		{
			if ( !std::isfinite( (double)t.wheelPosition[i][k] ) ) t.finite = false;
			if ( !std::isfinite( (double)t.groundNormal[i][k] ) ) t.finite = false;
		}
	}
}

static void ReleaseWorld()
{
	// The static instance owns the mesh bodies the wheel rays trace against, so it
	// has to outlive every step (the T-005d harness keeps it in scope for the whole
	// run; a library has to keep it explicitly). Release order matters: the import
	// scene is released through the live scene, so the scene must still exist.
	delete gWorld.car;
	gWorld.car = 0;
	gWorld.body = 0;
	delete gWorld.staticInstance;
	gWorld.staticInstance = 0;
	if ( gWorld.importScene )
	{
		Gravity::C_PhysicsSDK::PhysicsSDK()->ReleaseImportScene( gWorld.importScene );
		gWorld.importScene = 0;
	}
	if ( gWorld.scene )
	{
		Gravity::C_PhysicsSDK::PhysicsSDK()->ReleaseScene( gWorld.scene );
		gWorld.scene = 0;
	}
	// The scene destructor flushes both group handles (Scene.cpp:150-151), so the
	// groups can only be returned to the pool after the scene is gone. DestroyGroup
	// flushes the group and sets the handle back to JQ_GROUP_NONE.
	if ( gWorld.broadPhaseGroup != Scheduler::JQ_GROUP_NONE )
		Scheduler::DestroyGroup( gWorld.broadPhaseGroup );
	if ( gWorld.group != Scheduler::JQ_GROUP_NONE )
		Scheduler::DestroyGroup( gWorld.group );
	gWorld.ready = false;
}

// Build scene + car and run the settle phase. Same order as the T-005d harness.
static bool BuildWorld()
{
	using namespace Maths;
	ReleaseWorld();

	if ( !gWorld.levelCopy || gWorld.levelLen <= 0 )
	{
		SetError( "no level bytes; call e1_create first" );
		return false;
	}
	unsigned mainOffset = 0, mainLen = 0;
	const char* why = "";
	if ( !FindMainBlock( gWorld.levelCopy, (size_t)gWorld.levelLen, mainOffset, mainLen, why ) )
	{
		char msg[128];
		std::snprintf( msg, sizeof msg, "level Main block: %s", why );
		SetError( msg );
		return false;
	}

	InitialiseScheduler();
	static MaterialMatrix materials;
	Gravity::C_PhysicsSDK* sdk = Gravity::C_PhysicsSDK::PhysicsSDK();
	Gravity::C_Scene* scene = sdk->CreateScene( &materials.pair, 1 );
	gWorld.scene = scene;
	// GameWorld.cpp:561 installs the game's own collision/physics policy. Without
	// it the scene's internal task policy stays zero and the vehicle integration
	// job never runs (measured: throttle produced no force).
	scene->SetInternalTaskPolicy( gScenePolicy );
	// GameWorld.cpp:562-563 also installs the two scheduler groups the physics
	// jobs run in. C_Scene's constructor creates none and leaves both members
	// uninitialised (Scene.cpp:133-136), so without this the scene flushes a heap
	// value as a group index. One pair per scene, created here and destroyed with
	// the scene, is the lifetime this library gives the world; 16 pool slots are
	// requested above and 3 are already taken by the physics statics
	// (integrate.cpp:30-31, carnetworkphysics.cpp:43).
	gWorld.group = Scheduler::CreateGroup();
	gWorld.broadPhaseGroup = Scheduler::CreateGroup();
	scene->SetInternalGroupHandle( gWorld.group );
	scene->SetBroadPhaseGroupHandle( gWorld.broadPhaseGroup );

	Sys::C_MemoryStream stream( (U8*)( gWorld.levelCopy + mainOffset + 16 ), (U32)( mainLen - 16 ) );
	gWorld.importScene = sdk->CreateImportScene();
	if ( !gWorld.importScene->Import( &stream ) )
	{
		SetError( "C_ImportScene::Import returned false" );
		return false;
	}

	{
		gWorld.staticInstance = new Gravity::C_ImportSceneStaticInstance(
			scene, gWorld.importScene, HVec3( 5.f, 20.f, 5.f ), HVec3( 50.f, 50.f, 50.f ),
			&gWorld.filter, &gWorld.filter );
		Gravity::C_ImportSceneStaticInstance& instance = *gWorld.staticInstance;
		(void)instance;

		// AddMeshBody is deferred; the game processes the queue inside the first
		// _Simulate, the level load has no tick, so drain it here (T-005d §4).
		scene->ProcessCommands();

		// ground probe: one tall narrow column over the start point, the same
		// fill+trace the wheel uses.
		float groundY = 0.0f;
		{
			void* data[512];
			SharedPhysics::C_SafeStack<true> stack( data, 512 );
			Collision::C_LineCollisionCache cache( 128 );
			const float probeTop = 130.0f;
			const float probeHalfHeight = 150.0f;
			Collision::C_CRAxisBox box;
			box.centre = HVec3( gWorld.startX, probeTop - probeHalfHeight, gWorld.startZ );
			box.extents = HVec3( 1.0f, probeHalfHeight, 1.0f );
			const C_Normal down( Constants<HVec3>::UnitAxisNegativeY(), C_Normal::UNIT_LENGTH_VECTOR );
			cache.Reset();
			scene->FillCache( box, cache, stack, &gWorld.filter, down,
			                  HF32( -Constants<HF32>::Quarter() ) );
			Collision::C_Ray ray;
			ray.InitialiseRay( C_Vertex( gWorld.startX, probeTop, gWorld.startZ ), down, 400.f, &gWorld.filter, 0.f );
			ray.SetMaxCosAngle( -Constants<HF32>::Quarter() );
			Collision::C_SingleTriangleCache tri;
			cache.Trace( ray, &tri );
			if ( ray.m_result.m_pShape == NULL )
			{
				char msg[192];
				std::snprintf( msg, sizeof msg,
				               "no ground at (%.4f, %.4f); cachedTriangles=%u staticInstances=%u",
				               gWorld.startX, gWorld.startZ,
				               (unsigned)( cache.m_High - cache.m_Low ),
				               (unsigned)gWorld.importScene->m_StaticInstance.m_numElements );
				SetError( msg );
				return false;
			}
			groundY = ray.m_result.m_contact.Y();
		}

		// Zeroed storage before the constructor, exactly like the T-005d harness's
		// `static RacingPhysics::Car car;`. Without it a rebuild can reuse heap
		// bytes from the previous car and any member the constructor leaves alone
		// makes a reset run differ from a fresh run (measured: 1e-8 on tick 0).
		void* carMemory = std::calloc( 1, sizeof( RacingPhysics::Car ) );
		if ( !carMemory )
		{
			SetError( "out of memory allocating the car" );
			return false;
		}
		RacingPhysics::Car* car = new ( carMemory ) RacingPhysics::Car();
		car->SetWebCarDynamics( &gWorld.dyn );
		RacingPhysics::VehicleInitialiseInfo info;
		info.folder = "";
		info.filename = gWorld.carName;
		info.vehicleIndex = 0;
		info.controlType = RacingPhysics::Vehicle::CONTROL_TYPE_PLAYER;
		info.controllerPort = -1;
		info.autoGears = true;
		info.autoReverse = true;
		info.forceHandbrake = false;
		info.vehicleToVehicleCollisions = false;
		car->Initialise( info );
		car->SetGravityScene( scene );

		const float rideHeight = gWorld.dyn.tyres.frontTyres.radius + gWorld.dyn.suspension.front.movementUp;
		const float startY = groundY + rideHeight;

		// Body basis for the spawn heading. Built explicitly so the only inputs are
		// the basis vectors the engine's own Axis exposes (see e1_info/the docs:
		// the local +Z axis is the car's longitudinal axis).
		const float c = std::cos( gWorld.heading );
		const float s = std::sin( gWorld.heading );
		const HVec3 basisX( c, 0.f, -s );
		const HVec3 basisY( 0.f, 1.f, 0.f );
		const HVec3 basisZ( s, 0.f, c );
		const HMat33 orientation( basisX, basisY, basisZ );

		RacingPhysics::Axis axis;
		axis.SetIdentityMatrix();
		axis.SetRotation( orientation );
		axis.SetPosition( RacingPhysics::Point3R( gWorld.startX, startY, gWorld.startZ ) );
		car->SetAxis( axis );

		Gravity::C_Body* body = scene->CreateBody();
		{
			Gravity::C_BoxDesc boxDesc;
			boxDesc.m_HalfExtents = HVec3( gWorld.dyn.geometry.trackWidthFront * 0.5f,
			                               gWorld.dyn.tyres.frontTyres.radius,
			                               gWorld.dyn.geometry.wheelBase * 0.5f );
			boxDesc.m_PhysicsMaterialIndex = 0;
			boxDesc.m_EffectMaterialIndex = 0;
			// Element offset: moves the collision element inside the body without
			// touching its mass, inertia tensor or centre of mass.
			boxDesc.m_RenderOffset = HVec3( 0.f, kChassisProxyLiftMetres, 0.f );
			Gravity::C_BodyHelper helper( &boxDesc );
			helper.CreateBody( HF32( gWorld.dyn.mass.mass ), HVec3( gWorld.startX, startY, gWorld.startZ ),
			                   orientation, body, &gWorld.filter );
		}
		auto gravityConstants = new Gravity::C_ExternalConstants();
		gravityConstants->m_Gravity = HVec3( 0.f, -9.8f, 0.f );
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

		const HVec3 bounds( gWorld.dyn.geometry.trackWidthFront * 0.5f,
		                    gWorld.dyn.tyres.frontTyres.radius,
		                    gWorld.dyn.geometry.wheelBase * 0.5f );
		car->SetGravityBody( body, HVec3( 0.f, 0.f, 0.f ), bounds, HVec3( 0.f, 0.f, 0.f ) );

		scene->AddBody( body );
		scene->SetMinTimeStep( HF32( -1.f ) ); // GameWorld.cpp:2569

		RacingPhysics::PhysicsTimer::Instance().InitialiseTimers();
		RacingPhysics::PhysicsTimer::Instance().SetPhysicsUpdateTime( kDt );

		gWorld.car = car;
		gWorld.body = body;
		gWorld.groundY = groundY;
		gWorld.startY = startY;

		// ---- settle phase: kWarmupTicks at rest (T-005d settle) ------------
		for ( int i = 0; i < kWarmupTicks; ++i )
		{
			RacingPhysics::CarControls& controls = car->Controls();
			controls.Clear();
			car->DriverSettings().autoGears = true;
			car->DriverSettings().tractionControl = true;
			car->DriverSettings().ABS = true;
			scene->Simulate( C_TimeS( kDt ) );
			RacingPhysics::PhysicsTimer::Instance().UpdatePhysicsTimer();
		}
	}

	gWorld.input[0] = gWorld.input[1] = gWorld.input[2] = gWorld.input[3] = 0.0f;
	gWorld.tick = 0;
	gWorld.ready = true;
	gWorld.resetCount++;
	return true;
}

// --------------------------------------------------------------- json output

static void PutNumber( char*& p, char* end, float v )
{
	int n;
	if ( std::isfinite( (double)v ) )
		n = std::snprintf( p, (size_t)( end - p ), "%.9g", (double)v );
	else
		n = std::snprintf( p, (size_t)( end - p ), "\"%s\"", std::isnan( (double)v ) ? "NaN" : "Inf" );
	if ( n > 0 ) p += n;
}

static void PutVec( char*& p, char* end, const float* v, int count )
{
	if ( p < end ) *p++ = '[';
	for ( int i = 0; i < count; ++i )
	{
		if ( i && p < end ) *p++ = ',';
		PutNumber( p, end, v[i] );
	}
	if ( p < end ) *p++ = ']';
}

static void SerialiseState( const TickState& t )
{
	char* p = s_state;
	char* end = s_state + sizeof s_state - 1;
	std::snprintf( p, (size_t)( end - p ),
	               "{\"status\":\"ok\",\"tick\":%d,\"dt\":%.9g,\"position\":",
	               gWorld.tick, (double)kDt );
	p += std::strlen( p );
	PutVec( p, end, t.position, 3 );
	std::snprintf( p, (size_t)( end - p ), ",\"axisX\":" );
	p += std::strlen( p );
	PutVec( p, end, t.axisX, 3 );
	std::snprintf( p, (size_t)( end - p ), ",\"axisY\":" );
	p += std::strlen( p );
	PutVec( p, end, t.axisY, 3 );
	std::snprintf( p, (size_t)( end - p ), ",\"axisZ\":" );
	p += std::strlen( p );
	PutVec( p, end, t.axisZ, 3 );
	std::snprintf( p, (size_t)( end - p ), ",\"velocity\":" );
	p += std::strlen( p );
	PutVec( p, end, t.velocity, 3 );
	std::snprintf( p, (size_t)( end - p ), ",\"angular\":" );
	p += std::strlen( p );
	PutVec( p, end, t.angular, 3 );
	std::snprintf( p, (size_t)( end - p ), ",\"speed\":" );
	p += std::strlen( p );
	PutNumber( p, end, t.speed );
	std::snprintf( p, (size_t)( end - p ), ",\"contacts\":[" );
	p += std::strlen( p );
	for ( int i = 0; i < 4; ++i )
	{
		if ( i && p < end ) *p++ = ',';
		if ( p < end ) *p++ = t.wheelOnGround[i] ? '1' : '0';
	}
	std::snprintf( p, (size_t)( end - p ), "],\"wheels\":[" );
	p += std::strlen( p );
	for ( int i = 0; i < 4; ++i )
	{
		if ( i && p < end ) *p++ = ',';
		std::snprintf( p, (size_t)( end - p ), "{\"onGround\":%d,\"suspension\":", t.wheelOnGround[i] ? 1 : 0 );
		p += std::strlen( p );
		PutNumber( p, end, t.suspension[i] );
		std::snprintf( p, (size_t)( end - p ), ",\"position\":" );
		p += std::strlen( p );
		PutVec( p, end, t.wheelPosition[i], 3 );
		std::snprintf( p, (size_t)( end - p ), ",\"angular\":" );
		p += std::strlen( p );
		PutNumber( p, end, t.wheelAngular[i] );
		std::snprintf( p, (size_t)( end - p ), ",\"surface\":%u,\"userData\":%u,\"groundNormal\":",
		               t.surfaceFlags[i], t.userData[i] );
		p += std::strlen( p );
		PutVec( p, end, t.groundNormal[i], 3 );
		if ( p < end ) *p++ = '}';
	}
	std::snprintf( p, (size_t)( end - p ),
	               "],\"finite\":%d,\"anyContact\":%d,\"input\":", t.finite ? 1 : 0, t.anyContact ? 1 : 0 );
	p += std::strlen( p );
	PutVec( p, end, gWorld.input, 4 );
	std::snprintf( p, (size_t)( end - p ), "}" );
}

} // namespace e1

// ------------------------------------------------------------------ C API

extern "C" __attribute__( ( visibility( "default" ) ) )
const char* e1_last_error()
{
	return e1::gWorld.error;
}

extern "C" __attribute__( ( visibility( "default" ) ) )
int e1_create( const char* levelData, int levelLen, const char* fieldData, int fieldLen,
               float startX, float startZ, float heading )
{
	using namespace e1;
	gWorld.error[0] = 0;
	if ( gWorld.created ) ReleaseWorld();
	gWorld.created = false;
	gWorld.ready = false;
	gWorld.tick = 0;
	gWorld.resetCount = 0;

	// Parse and validate the car record first: a bad field list must not leave a
	// half-built scene behind. The decoded record is written straight into the
	// persistent world: its XtArray members point at the buffers in `gWorld`, and
	// those pointers must survive this call (the T-005d harness keeps its locals
	// alive for the whole run for exactly this reason).
	gWorld.dyn = RacingPhysics::CarDynamicsXt();
	gWorld.buffers = CarBuffers();
	RacingPhysics::CarDynamicsXt& dyn = gWorld.dyn;
	CarBuffers& buffers = gWorld.buffers;
	char carName[128] = { 0 };
	int handle = 0;
	Fields fields( fieldData, (size_t)fieldLen );
	if ( !ReadCarFields( fields, dyn, buffers, carName, sizeof carName, handle ) )
	{
		SetError( fields.failed ? fields.err : "field list incomplete" );
		return 0;
	}
	{
		char key[128];
		const char* v = 0;
		if ( fields.next( key, sizeof key, &v ) )
		{
			char msg[192];
			std::snprintf( msg, sizeof msg, "line %d: trailing car field '%s'", fields.line, key );
			SetError( msg );
			return 0;
		}
	}

	if ( levelLen <= 0 || !levelData )
	{
		SetError( "empty level" );
		return 0;
	}
	unsigned char* copy = (unsigned char*)std::malloc( (size_t)levelLen );
	if ( !copy )
	{
		SetError( "out of memory copying the level" );
		return 0;
	}
	std::memcpy( copy, levelData, (size_t)levelLen );
	gWorld.levelCopy = copy;
	gWorld.levelLen = levelLen;
	std::snprintf( gWorld.carName, sizeof gWorld.carName, "%s", carName );
	gWorld.physicsParametersHandle = handle;
	gWorld.startX = startX;
	gWorld.startZ = startZ;
	gWorld.heading = heading;
	gWorld.created = true;

	return BuildWorld() ? 1 : 0;
}

extern "C" __attribute__( ( visibility( "default" ) ) )
int e1_reset()
{
	using namespace e1;
	gWorld.error[0] = 0;
	if ( !gWorld.created )
	{
		SetError( "e1_reset before e1_create" );
		return 0;
	}
	return BuildWorld() ? 1 : 0;
}

extern "C" __attribute__( ( visibility( "default" ) ) )
void e1_set_input( float throttle, float brake, float steer, float handbrake )
{
	e1::gWorld.input[0] = throttle;
	e1::gWorld.input[1] = brake;
	e1::gWorld.input[2] = steer;
	e1::gWorld.input[3] = handbrake;
}

extern "C" __attribute__( ( visibility( "default" ) ) )
int e1_step()
{
	using namespace e1;
	if ( !gWorld.ready )
	{
		SetError( "e1_step before a successful e1_create/e1_reset" );
		return 0;
	}
	RacingPhysics::CarControls& controls = gWorld.car->Controls();
	controls.Clear();
	controls.throttle = gWorld.input[0];
	controls.brake = gWorld.input[1];
	controls.steer = gWorld.input[2];
	controls.handbrake = gWorld.input[3];
	gWorld.car->DriverSettings().autoGears = true;
	gWorld.car->DriverSettings().tractionControl = true;
	gWorld.car->DriverSettings().ABS = true;
	gWorld.scene->Simulate( Maths::C_TimeS( kDt ) );
	RacingPhysics::PhysicsTimer::Instance().UpdatePhysicsTimer();
	gWorld.tick++;
	return 1;
}

extern "C" __attribute__( ( visibility( "default" ) ) )
const char* e1_get_state()
{
	using namespace e1;
	if ( !gWorld.ready )
	{
		std::snprintf( s_state, sizeof s_state, "{\"status\":\"error\",\"error\":\"not ready\"}" );
		return s_state;
	}
	TickState state;
	SampleCar( *gWorld.car, state );
	SerialiseState( state );
	return s_state;
}

// Live engine RPM. This is the same value the retail audio graph reads:
// `Engine().RPM()` (BaseMessageHandler.cpp:1940/1970 publishes
// `DynamicsRPM = RPM * .0001` to the `RPMInput` graph parameter). It is read
// straight from the integrated engine state, never derived from speed or a
// guessed gear. Returns -1 before a world is ready so the page keeps its audio
// silent instead of synthesising a value.
extern "C" __attribute__( ( visibility( "default" ) ) )
float e1_engine_rpm()
{
	using namespace e1;
	if ( !gWorld.ready || !gWorld.car ) return -1.f;
	return (float)gWorld.car->Engine().RPM();
}

// Metadata the page and the verifier report without asking the state: settled
// ground height, ride height, car identity, the reset counter and the tick.
extern "C" __attribute__( ( visibility( "default" ) ) )
const char* e1_info()
{
	using namespace e1;
	static char s_info[768];
	std::snprintf( s_info, sizeof s_info,
	               "{\"status\":\"%s\",\"car\":\"%s\",\"physicsParametersHandle\":%d,"
	               "\"startX\":%.9g,\"startZ\":%.9g,\"heading\":%.9g,"
	               "\"groundY\":%.9g,\"startY\":%.9g,\"dt\":%.9g,"
	               "\"warmupTicks\":%d,\"tick\":%d,\"resets\":%u,"
	               "\"chassisProxy\":\"box-from-XT-geometry\",\"chassisProxyLift\":%.9g,"
	               "\"sizeofCarDynamicsXt\":%u}",
	               gWorld.ready ? "ok" : "error", gWorld.carName, gWorld.physicsParametersHandle,
	               (double)gWorld.startX, (double)gWorld.startZ, (double)gWorld.heading,
	               (double)gWorld.groundY, (double)gWorld.startY, (double)kDt,
	               kWarmupTicks, gWorld.tick, gWorld.resetCount,
	               (double)kChassisProxyLiftMetres,
	               (unsigned)sizeof( RacingPhysics::CarDynamicsXt ) );
	return s_info;
}

// Diagnostic snapshot of the live world's scheduler wiring. Not used by the
// page or by the physics path: it exists so the rebuild limit can be measured
// instead of guessed (which group handle the release/build code leaves behind,
// and what the scheduler pool holds after each cycle).
extern "C" __attribute__( ( visibility( "default" ) ) )
const char* e1_diag()
{
	using namespace e1;
	static char s_diag[4096];
	char* p = s_diag;
	char* end = s_diag + sizeof s_diag - 1;
	int n = std::snprintf( p, (size_t)( end - p ),
	                       "{\"status\":\"%s\",\"ready\":%d,\"created\":%d,\"tick\":%d,\"resets\":%u,"
	                       "\"scene\":%u,\"body\":%u,\"car\":%u,\"group\":%d,\"policy\":%d,",
	                       gWorld.ready ? "ok" : "error", gWorld.ready ? 1 : 0, gWorld.created ? 1 : 0,
	                       gWorld.tick, gWorld.resetCount,
	                       (unsigned)(size_t)gWorld.scene, (unsigned)(size_t)gWorld.body,
	                       (unsigned)(size_t)gWorld.car,
	                       gWorld.scene ? (int)gWorld.scene->GetInternalGroupHandle() : -1000,
	                       gWorld.scene ? (int)gWorld.scene->GetInternalTaskPolicy() : -1000 );
	if ( n > 0 ) p += n;
	// The live collision box in world space: proves the proxy lift geometrically
	// instead of trusting the descriptor field. `extra` is the box height above the
	// wheel-contact plane at the settled pose.
	{
		const Collision::C_CRAxisBox& box = gWorld.body->GetObject()->m_TransformedBox;
		n = std::snprintf( p, (size_t)( end - p ),
		                   "\"chassisProxyLift\":%.9g,\"collisionBox\":{\"centre\":[%.9g,%.9g,%.9g],"
		                   "\"extents\":[%.9g,%.9g,%.9g]},",
		                   (double)kChassisProxyLiftMetres,
		                   (double)box.centre.X(), (double)box.centre.Y(), (double)box.centre.Z(),
		                   (double)box.extents.X(), (double)box.extents.Y(), (double)box.extents.Z() );
		if ( n > 0 ) p += n;
	}
	AppendSchedulerDiagnostics( p, end );
	std::snprintf( p, (size_t)( end - p ), "}" );
	return s_diag;
}

// Probe the collision mesh along an arbitrary world-space direction (diagnostic).
//
// e1_ground_probe answers "what is the ground here". This answers "what is in the
// way": it traces one line and reports the hit point, the surface normal and the
// shape's physics/effect material indices. It exists so a blocked car can be
// diagnosed from the engine's own collision data instead of guessed from the
// render mesh; the page and the physics path never call it.
extern "C" __attribute__( ( visibility( "default" ) ) )
const char* e1_ray_probe( float x, float y, float z, float dx, float dy, float dz, float maxDistance )
{
	using namespace e1;
	using namespace Maths;
	std::snprintf( s_probe, sizeof s_probe, "{\"status\":\"error\",\"error\":\"no scene\"}" );
	if ( !gWorld.scene )
	{
		SetError( "e1_ray_probe needs a built world" );
		return s_probe;
	}
	const float length = std::sqrt( dx * dx + dy * dy + dz * dz );
	if ( !( length > 1e-6f ) || !( maxDistance > 0.f ) )
	{
		std::snprintf( s_probe, sizeof s_probe, "{\"status\":\"error\",\"error\":\"bad direction\"}" );
		return s_probe;
	}
	const HVec3 direction( dx / length, dy / length, dz / length );
	const C_Normal normal( direction, C_Normal::UNIT_LENGTH_VECTOR );
	const HVec3 start( x, y, z );
	const HVec3 middle( x + direction.X() * maxDistance * 0.5f,
	                    y + direction.Y() * maxDistance * 0.5f,
	                    z + direction.Z() * maxDistance * 0.5f );

	Collision::C_CollisionFilter filter;
	void* data[512];
	SharedPhysics::C_SafeStack<true> stack( data, 512 );
	Collision::C_LineCollisionCache cache( 128 );
	Collision::C_CRAxisBox box;
	box.centre = middle;
	box.extents = HVec3( std::fabs( direction.X() ) * maxDistance * 0.5f + 1.0f,
	                     std::fabs( direction.Y() ) * maxDistance * 0.5f + 1.0f,
	                     std::fabs( direction.Z() ) * maxDistance * 0.5f + 1.0f );
	cache.Reset();
	gWorld.scene->FillCache( box, cache, stack, &gWorld.filter, normal, HF32( -Constants<HF32>::Quarter() ) );
	Collision::C_Ray ray;
	ray.InitialiseRay( C_Vertex( x, y, z ), normal, maxDistance, &filter, 0.f );
	ray.SetMaxCosAngle( -Constants<HF32>::Quarter() );
	Collision::C_SingleTriangleCache tri;
	cache.Trace( ray, &tri );
	if ( ray.m_result.m_pShape == NULL )
	{
		std::snprintf( s_probe, sizeof s_probe,
		               "{\"status\":\"ok\",\"hit\":0,\"distance\":%.9g,\"cachedTriangles\":%u}",
		               (double)maxDistance, (unsigned)( cache.m_High - cache.m_Low ) );
		return s_probe;
	}
	const Maths::C_Normal& n = ray.m_result.m_normal;
	const HVec3& contact = ray.m_result.m_contact;
	const Collision::C_Shape* shape = ray.m_result.m_pShape;
	std::snprintf( s_probe, sizeof s_probe,
	               "{\"status\":\"ok\",\"hit\":1,\"point\":[%.9g,%.9g,%.9g],"
	               "\"normal\":[%.9g,%.9g,%.9g],\"distance\":%.9g,"
	               "\"physicsMaterial\":%u,\"effectMaterial\":%u,\"cachedTriangles\":%u}",
	               (double)contact.X(), (double)contact.Y(), (double)contact.Z(),
	               (double)n.X(), (double)n.Y(), (double)n.Z(),
	               (double)std::sqrt( ( contact.X() - x ) * ( contact.X() - x ) +
	                                  ( contact.Y() - y ) * ( contact.Y() - y ) +
	                                  ( contact.Z() - z ) * ( contact.Z() - z ) ),
	               (unsigned)shape->PhysicsMaterialIndex(), (unsigned)shape->EffectMaterialIndex(),
	               (unsigned)( cache.m_High - cache.m_Low ) );
	return s_probe;
}

// Probe the collision mesh at one point without creating a car. Used to choose
// and to prove the spawn point instead of guessing one.
extern "C" __attribute__( ( visibility( "default" ) ) )
const char* e1_ground_probe( float x, float z )
{
	using namespace e1;
	using namespace Maths;
	std::snprintf( s_probe, sizeof s_probe, "{\"status\":\"error\",\"error\":\"no scene\"}" );
	if ( !gWorld.scene )
	{
		SetError( "e1_ground_probe needs a built world" );
		return s_probe;
	}
	Collision::C_CollisionFilter filter;
	void* data[512];
	SharedPhysics::C_SafeStack<true> stack( data, 512 );
	Collision::C_LineCollisionCache cache( 128 );
	const float probeTop = 130.0f;
	const float probeHalfHeight = 150.0f;
	Collision::C_CRAxisBox box;
	box.centre = HVec3( x, probeTop - probeHalfHeight, z );
	box.extents = HVec3( 1.0f, probeHalfHeight, 1.0f );
	const C_Normal down( Constants<HVec3>::UnitAxisNegativeY(), C_Normal::UNIT_LENGTH_VECTOR );
	cache.Reset();
	gWorld.scene->FillCache( box, cache, stack, &gWorld.filter, down, HF32( -Constants<HF32>::Quarter() ) );
	Collision::C_Ray ray;
	ray.InitialiseRay( C_Vertex( x, probeTop, z ), down, 400.f, &filter, 0.f );
	ray.SetMaxCosAngle( -Constants<HF32>::Quarter() );
	Collision::C_SingleTriangleCache tri;
	cache.Trace( ray, &tri );
	if ( ray.m_result.m_pShape == NULL )
	{
		std::snprintf( s_probe, sizeof s_probe,
		               "{\"status\":\"ok\",\"x\":%.9g,\"z\":%.9g,\"hit\":0,\"cachedTriangles\":%u}",
		               (double)x, (double)z, (unsigned)( cache.m_High - cache.m_Low ) );
		return s_probe;
	}
	const Maths::C_Normal& n = ray.m_result.m_normal;
	std::snprintf( s_probe, sizeof s_probe,
	               "{\"status\":\"ok\",\"x\":%.9g,\"z\":%.9g,\"hit\":1,\"y\":%.9g,"
	               "\"normal\":[%.9g,%.9g,%.9g],\"cachedTriangles\":%u}",
	               (double)x, (double)z, (double)ray.m_result.m_contact.Y(),
	               (double)n.X(), (double)n.Y(), (double)n.Z(),
	               (unsigned)( cache.m_High - cache.m_Low ) );
	return s_probe;
}
