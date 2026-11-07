// BOOST1 feasibility probe — a *temporary measurement harness*.
//
// This file is not engine code and is not the shipped e1 library. It compiles
// the exact committed `probes/e1-drive/native/e1_drive_lib.cpp` translation unit
// by inclusion (so the world build, settle, controls and state serialisation are
// byte-for-byte the shipped code) and adds only experimental step hooks that let
// a Node driver measure three candidate boost implementations:
//
//   mode 0  baseline: the engine steps the car with e1's own controls
//   mode 1  engine force before Simulate (retail FakeVehicleSpeedState shape)
//   mode 2  CarPerformanceModifiers().peakTorqueScale before Simulate
//   mode 3  post-tick gravity-body velocity write (outside Simulate)
//   mode 4  post-tick gravity-body pose write (outside Simulate)
//
// The hook is deliberately outside the shared library so no e1-drive, engine or
// shared file is modified. `b_step()` duplicates the eleven lines of e1_step()
// that set CarControls and call Simulate; that duplication is the whole point:
// the measurement needs a seam immediately before and after the one engine call.
//
// All values are measured from the engine's own state. Nothing here changes a
// shared file, a fixture or a rendered packet.

#include "../../e1-drive/native/e1_drive_lib.cpp"

namespace boostprobe
{
	struct BoostState
	{
		int mode;
		float a;      // force N (mode 1), torque scale (mode 2), dv m/s (mode 3), step m (mode 4)
		float b;      // target speed m/s (mode 1), unused otherwise
		float c;      // retail "adjust" switch: 1 = 2x below half target, 0 = off
		int ticks;    // remaining applying ticks; 0 = off
		int applied;
		float forceN;
		float dv;
		float stepM;

		BoostState() : mode(0), a(0), b(0), c(1), ticks(0), applied(0),
		               forceN(0), dv(0), stepM(0) {}
	};

	static BoostState gBoost;
	static char s_extra[4096];

	static Maths::HVec3 ForwardHorizontal( const RacingPhysics::Car& car )
	{
		Maths::HVec3 f = car.GetAxis().Matrix3().AZ();
		f.Y( 0.f );
		return f;
	}

	// Retail FakeVehicleSpeedState::Update (FakePhysics.cpp:700-753) applies a
	// body-space forward force of `SpeedAccelerateForce * mass * adjust` while the
	// forward speed is below the target, with `adjust = 2` below half the target.
	// Mode 1 reproduces that shape; the constants are supplied by the driver so a
	// sweep is a data change, not a recompile.
	static void ApplyPreStep()
	{
		if ( !e1::gWorld.ready || !e1::gWorld.car || !e1::gWorld.body || gBoost.ticks <= 0 ) return;

		if ( gBoost.mode == 1 )
		{
			RacingPhysics::Car& car = *e1::gWorld.car;
			const Maths::HVec3 fwd = ForwardHorizontal( car );
			const SharedPhysics::C_RigidBody& rb = e1::gWorld.body->GetBody();
			const Maths::HF32 fwdSpeed = Maths::DotProduct( rb.m_LinearVelocity, fwd );
			if ( fwdSpeed < gBoost.b )
			{
				float adjust = ( gBoost.c != 0.f && fwdSpeed < gBoost.b * 0.5f ) ? 2.f : 1.f;
				const Maths::HVec3 force = fwd * ( gBoost.a * rb.Mass() * adjust );
				e1::gWorld.body->GetBody().AddForce( force );
				gBoost.forceN = gBoost.a * rb.Mass() * adjust;
			}
			else
			{
				gBoost.forceN = 0.f;
			}
		}
		else if ( gBoost.mode == 2 )
		{
			e1::gWorld.car->PerformanceModifiers().peakTorqueScale = gBoost.a;
		}
		else if ( gBoost.mode == 5 )
		{
			// Retail FakeVehicleSpeedState::Update E_FAKE_SPEED_BRAKE
			// (FakePhysics.cpp:755-775): a force opposite the velocity, scaled by
			// rate * mass * adjust / speed, while the speed is above the target.
			SharedPhysics::C_RigidBody& rb = e1::gWorld.body->GetBody();
			const float speed = Maths::Magnitude( RacingPhysics::Vector3R( rb.m_LinearVelocity ) );
			if ( speed > gBoost.b && speed > 1e-3f )
			{
				float adjust = ( gBoost.c != 0.f && speed > gBoost.b * 2.f ) ? 2.f : 1.f;
				const Maths::HVec3 force = rb.m_LinearVelocity * ( -( gBoost.a * rb.Mass() * adjust ) / speed );
				e1::gWorld.body->GetBody().AddForce( force );
				gBoost.forceN = -gBoost.a * rb.Mass() * adjust;
			}
			else
			{
				gBoost.forceN = 0.f;
			}
		}
		else if ( gBoost.mode == 6 )
		{
			// One-shot engine impulse. This is the primitive a Shunt/Barge push
			// would use; it is applied before Simulate, so the solver sees it.
			if ( gBoost.applied == 0 )
			{
				SharedPhysics::C_RigidBody& rb = e1::gWorld.body->GetBody();
				const Maths::HVec3 dir = ( gBoost.c > 0.f )
					? ForwardHorizontal( *e1::gWorld.car )
					: e1::gWorld.car->GetAxis().Matrix3().AX();
				rb.AddImpulse( dir * gBoost.a );
				gBoost.dv = std::fabs( gBoost.a ) / rb.Mass();
				gBoost.forceN = gBoost.a;
			}
		}
	}

	static void ApplyPostStep()
	{
		if ( !e1::gWorld.ready || !e1::gWorld.body || gBoost.ticks <= 0 ) return;

		if ( gBoost.mode == 3 )
		{
			SharedPhysics::C_RigidBody& rb = e1::gWorld.body->GetBody();
			const Maths::HVec3 fwd = ForwardHorizontal( *e1::gWorld.car );
			rb.StoreLinearVelocity( rb.m_LinearVelocity + fwd * gBoost.a );
			gBoost.dv = gBoost.a;
		}
		else if ( gBoost.mode == 4 )
		{
			const Maths::HVec3 fwd = ForwardHorizontal( *e1::gWorld.car );
			const Maths::HVec3 p = e1::gWorld.body->Position();
			e1::gWorld.body->Position( p + fwd * gBoost.a );
			gBoost.stepM = gBoost.a;
		}
	}
}

extern "C" __attribute__( ( visibility( "default" ) ) )
int b_set_mode( int mode, float a, float b, float c, int ticks )
{
	using namespace boostprobe;
	if ( mode < 0 || mode > 6 ) return 0;
	gBoost.mode = mode;
	gBoost.a = a;
	gBoost.b = b;
	gBoost.c = c;
	gBoost.ticks = ticks < 0 ? 0 : ticks;
	gBoost.applied = 0;
	gBoost.forceN = 0.f;
	gBoost.dv = 0.f;
	gBoost.stepM = 0.f;
	// Leaving a torque multiplier behind would contaminate the next run in the
	// same module instance. The shipped default is 1.0 (car.h:514).
	if ( mode != 2 && e1::gWorld.car )
		e1::gWorld.car->PerformanceModifiers().peakTorqueScale = 1.f;
	return 1;
}

extern "C" __attribute__( ( visibility( "default" ) ) )
int b_step()
{
	using namespace e1;
	if ( !gWorld.ready )
	{
		SetError( "b_step before a successful e1_create/e1_reset" );
		return 0;
	}
	boostprobe::ApplyPreStep();

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

	boostprobe::ApplyPostStep();
	if ( boostprobe::gBoost.ticks > 0 )
	{
		boostprobe::gBoost.ticks--;
		boostprobe::gBoost.applied++;
	}
	return 1;
}

// The extra measurements a boost candidate needs on top of e1_get_state:
// live engine RPM/gear/throttle, forward speed along the body axis, the four
// wheel spin rates and the force/velocity/step this tick actually applied.
extern "C" __attribute__( ( visibility( "default" ) ) )
const char* b_extra()
{
	using namespace e1;
	using namespace boostprobe;
	static char* p;
	static char* end;
	if ( !gWorld.ready )
	{
		std::snprintf( s_extra, sizeof s_extra, "{\"status\":\"error\",\"error\":\"not ready\"}" );
		return s_extra;
	}
	p = s_extra;
	end = s_extra + sizeof s_extra - 1;
	RacingPhysics::Car& car = *gWorld.car;
	const Maths::HVec3 fwd = ForwardHorizontal( car );
	const SharedPhysics::C_RigidBody& rb = gWorld.body->GetBody();
	const float fwdSpeed = Maths::DotProduct( rb.m_LinearVelocity, fwd );
	int n = std::snprintf( p, (size_t)( end - p ),
	                       "{\"status\":\"ok\",\"mode\":%d,\"ticks\":%d,\"applied\":%d,"
	                       "\"rpm\":%.9g,\"gear\":%d,\"throttle\":%.9g,\"brake\":%.9g,"
	                       "\"adjustedThrottle\":%.9g,\"powerCut\":%d,"
	                       "\"mass\":%.9g,\"forwardSpeed\":%.9g,"
	                       "\"forceN\":%.9g,\"dv\":%.9g,\"stepM\":%.9g,"
	                       "\"wheelAngular\":[",
	                       gBoost.mode, gBoost.ticks, gBoost.applied,
	                       (double)car.Engine().RPM(), car.GetGear(),
	                       (double)car.Throttle(), (double)car.Brake(),
	                       (double)car.Engine().AdjustedThrottle(), car.Engine().PowerCut() ? 1 : 0,
	                       (double)rb.Mass(), (double)fwdSpeed,
	                       (double)gBoost.forceN, (double)gBoost.dv, (double)gBoost.stepM );
	if ( n > 0 ) p += n;
	for ( int i = 0; i < 4; ++i )
	{
		n = std::snprintf( p, (size_t)( end - p ), "%s%.9g", i ? "," : "",
		                   (double)car.Wheel( i ).GetAngularVelocity1D() );
		if ( n > 0 ) p += n;
	}
	n = std::snprintf( p, (size_t)( end - p ), "]}" );
	if ( n > 0 ) p += n;
	return s_extra;
}
