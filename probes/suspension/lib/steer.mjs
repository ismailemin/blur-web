// Provisional front-wheel steering angle for the visualiser.
//
// Why this exists
// ---------------
// The engine computes the wheel steering angle every step:
//   CarWheel::PutWheelOnGround()  m_step.steeringAngle = CalculateSteeringAngle();
//   CarWheel::CalculateSteeringAngle()  (carwheel.cpp:305-318)
// and applies it in CarWheel::SetCarAxis():
//   m_pRotor->Rotate(CalculateSuspensionAxis(axis) * steeringAngle);  (carwheel.cpp:117-123)
// That value is NOT in the e1 state export (`probes/e1-drive/native/e1_drive_lib.cpp`
// SerialiseState, lines 1274-1333, exports onGround/suspension/position/angular/
// surface/userData/groundNormal only). Until e1_get_state adds `steer`, a visual
// consumer has to reconstruct a usable angle from values that ARE exported.
//
// This reconstruction is the kinematic front-axle angle that matches the observed
// body motion, not a read of the physics steering state:
//   v_long  = velocity . bodyZ
//   v_lat   = velocity . bodyX
//   yawRate = angular  . bodyY
//   a       = wheelBase / 2                  (body origin is mid-wheelbase:
//                                             CalculateRestPosition uses +-wb/2)
//   steer  = atan2(v_lat + yawRate * a, |v_long|)
// The result is filtered with a 0.05 s time constant and clamped to the XT
// `steering.steerLimit`. It is labelled `provisional` everywhere; it is exact
// only in the zero-slip limit. A sliding front tyre needs more angle than this,
// which is exactly why the real export is required.
//
// Sign convention: the physics steering axis is body +Y tilted by caster; a
// positive angle turns the wheel axle from +X toward -Z and the wheel forward
// from +Z toward +X, the same direction as a positive body yaw rate in the
// engine's axes (verified in `_work/e1-drive/p50-steer.mjs` output: steer +1
// produced yaw +1.05 rad/s at 18.7 m/s). The reconstruction therefore has the
// same sign as the observed yaw for forward motion.

export const PROVISIONAL_STEER_SOURCE =
  'provisional kinematic reconstruction (v_lat + yawRate*wheelBase/2) from e1 state; exact angle needs the e1 `steer` export';

const MIN_LONGITUDINAL_SPEED = 1.5; // m/s; below this the atan2 is noise-dominated
const FILTER_TIME = 0.05; // s

/**
 * One step of the provisional steer model.
 * `previous` is the filtered angle from the previous tick (radians, front axle).
 * Returns { steer, raw, filtered, clamped, valid }.
 */
export function provisionalSteer(wheel, body, config, previous, dt) {
  const vLong = body.velocity[0] * body.axisZ[0] + body.velocity[1] * body.axisZ[1] + body.velocity[2] * body.axisZ[2];
  const vLat = body.velocity[0] * body.axisX[0] + body.velocity[1] * body.axisX[1] + body.velocity[2] * body.axisX[2];
  const yawRate = body.angular[0] * body.axisY[0] + body.angular[1] * body.axisY[1] + body.angular[2] * body.axisY[2];
  const halfWheelBase = config.wheelBase / 2;
  const speed = Math.abs(vLong);
  const valid = Number.isFinite(speed) && speed >= MIN_LONGITUDINAL_SPEED;
  let raw = previous;
  if (valid) raw = Math.atan2(vLat + yawRate * halfWheelBase, speed);
  const alpha = 1 - Math.exp(-Math.max(dt, 0) / FILTER_TIME);
  const filtered = previous + (raw - previous) * alpha;
  const limit = Math.abs(config.steerLimit ?? 0);
  const limited = limit > 0 ? Math.max(-limit, Math.min(limit, filtered)) : 0;
  return {
    steer: limited,
    raw,
    filtered,
    clamped: filtered !== limited,
    valid,
    source: PROVISIONAL_STEER_SOURCE
  };
}

/** Front corners share the physics steering angle; the rear pair is fixed at zero. */
export function steerByCorner(frontAngle) {
  return {
    frontleft: frontAngle,
    frontright: frontAngle,
    backleft: 0,
    backright: 0
  };
}
