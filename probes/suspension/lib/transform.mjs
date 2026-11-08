// The derived per-corner visual transform.
//
// Retail chain (all steps traceable to the retail source):
//
//   1. Body pose            Car::GetAxis() -> position + axisX/axisY/axisZ.
//                           `probes/e1-drive/web/packet-adapter.js carMatrix`
//                           already turns this into the body world matrix.
//   2. Rest position         CarWheel::CalculateRestPosition (carwheel.cpp:90-99):
//                           body position + wheelbase/track offsets. In the
//                           model-rest placement used here, the model's wheel
//                           group translation takes its place; the settled
//                           state is the zero reference.
//   3. Suspension travel     CarWheel::EndIntegrate (carwheel.cpp:196):
//                             wheelPosition = restPosition
//                                           + suspensionAxis * suspensionDistance
//                           CarWheel::CalculateSuspensionAxis (carwheel.cpp:101-104):
//                             body Y rotated about body X by caster
//                           -> suspension axis local = (0, cos caster, -sin caster)
//                           Positive suspensionDistance = compression (wheel up);
//                           the range is [-movementDown, +movementUp].
//   4. Steer (front only)    CarWheel::SetCarAxis (carwheel.cpp:117-123):
//                             rotor rotation = body axis, then Rotate(
//                               CalculateSuspensionAxis(axis) * steeringAngle)
//                           One angle for both front wheels; rear angle 0.
//                           The angle comes from CalculateSteeringAngle()
//                           (carwheel.cpp:305-318), clamped by Car::CalculateSteerLimits
//                           (car.cpp:1609-1643). It is NOT exported today.
//   5. Camber / toe          Camber is *measured* in CalculateSlip
//                           (carwheel.cpp:341: dot(wheelAxisX, groundNormal));
//                           toe rotates only the tyre contact frame in
//                           PutWheelOnGround (carwheel.cpp:270-272). Retail's
//                           wheel mesh is the rotor rotation, so neither is an
//                           extra mesh term. Static XT camber/toe are therefore
//                           NOT applied by default (`applyStaticAlignment:false`);
//                           the sign of a non-zero camberAngle is unproven.
//   6. Spin                  The retail rotor integrates spin; the e1 slice
//                           integrates `wheel.angular` at 1/60 s and applies
//                           Rx(angle) about element-local +X (the proven axle,
//                           VehicleActor.cpp:5158-5197). Applied after steer.
//   7. Caliper static        VehicleActor.cpp:5198-5207: same wheel position,
//                           rotation [wheelAxisX, bodyAxisY, wheelAxisX x bodyAxisY],
//                           no spin. With steer it yaws with the upright.
//
// Retail render filter (applies to the wheel mesh): VehicleActor.cpp:5124-5140
// clamps the wheel position if suspensionDistance > m_fMaxWheelTravelFront/Rear
// or if the body-local Y exceeds it, pulling the wheel down along body Y.
// m_fMaxWheelTravel* comes from GameVehicleData XT (frontWheelMaxTravel /
// rearWheelMaxTravel, GameVehicleData.h:185-186) and is NOT decoded here, and
// the zero-field fallback is the debug value 0.05 m (VehicleActor.cpp:5413,
// 5516-5517). The clamp is implemented but off unless a caller supplies
// maxTravel; every output with it off is labelled `retailClampApplied:false`.

import {
  basisMatrix,
  multiply,
  translation,
  rotationAxis,
  rotationX,
  rotationFromBasis,
  transformPoint,
  transformDirection,
  column,
  cross,
  dot,
  normalize,
  headingFromForward,
  shortestAngle,
  determinant3,
  orthonormalityError
} from './mat4.mjs';
import { CORNERS, WHEEL_INDEX_TO_CORNER } from './car-config.mjs';

/** Suspension axis in body-local space: body Y rotated about body X by -caster. */
export function suspensionAxisLocal(caster) {
  return [0, Math.cos(caster), -Math.sin(caster)];
}

export function createVisualState(config, corners) {
  return {
    config,
    corners,
    spin: Object.fromEntries(CORNERS.map((corner) => [corner, 0])),
    lastTick: null,
    suspension0: null
  };
}

/** Record the settled suspension per corner (the visual zero reference). */
export function setSettled(state, wheels, suspensionByCorner = null) {
  if (suspensionByCorner) {
    state.suspension0 = { ...suspensionByCorner };
    return state.suspension0;
  }
  const settled = {};
  wheels.forEach((wheel, index) => {
    settled[WHEEL_INDEX_TO_CORNER[index]] = wheel.suspension;
  });
  state.suspension0 = settled;
  return settled;
}

/**
 * Integrate the per-corner spin exactly like packet-adapter.advanceWheelSpin:
 * the first state only establishes the tick, every later step adds
 * angular * dt * deltaTicks.
 */
export function advanceSpin(state, tick, wheels, dt) {
  if (state.lastTick === null) {
    state.lastTick = tick;
    return state.spin;
  }
  const deltaTicks = tick - state.lastTick;
  if (deltaTicks <= 0) return state.spin;
  wheels.forEach((wheel, index) => {
    const corner = WHEEL_INDEX_TO_CORNER[index];
    if (!Number.isFinite(wheel.angular)) throw new Error('non-finite wheel angular at tick ' + tick + ' index ' + index);
    state.spin[corner] += wheel.angular * dt * deltaTicks;
  });
  state.lastTick = tick;
  return state.spin;
}

/**
 * Compute the four corner transforms for one recorded tick.
 *
 * options:
 *   placement: 'model-rest' (default) | 'physics'
 *     model-rest keeps the committed manifest wheel translation (the wheel work's
 *     rest pose) and adds only the physics suspension delta. 'physics' places the
 *     node at `wheel.position`, which is what VehicleActor.cpp:5081 does.
 *   applyStaticAlignment: false (default). If true, applies XT static toe about
 *     the suspension axis and camber about local Z. Not retail-faithful; camber
 *     sign is unproven. Off for every recorded result.
 *   retailClamp: false (default). If true, `maxTravelFront/Rear` must be finite.
 *   steerByCorner: {frontleft, frontright, backleft, backright} in radians.
 */
export function cornerTransforms(tick, state, options = {}) {
  const config = state.config;
  if (!state.suspension0) throw new Error('cornerTransforms before setSettled');
  const placement = options.placement ?? 'model-rest';
  if (placement !== 'model-rest' && placement !== 'physics') throw new Error('unknown placement ' + placement);
  const body = tick.body;
  const bodyMatrix = basisMatrix(body.axisX, body.axisY, body.axisZ, body.position);
  const corners = {};
  tick.wheels.forEach((wheel, index) => {
    const corner = WHEEL_INDEX_TO_CORNER[index];
    const model = state.corners[corner];
    const isFront = corner === 'frontleft' || corner === 'frontright';
    const side = isFront ? config.front : config.rear;
    const suspensionAxis = suspensionAxisLocal(side.caster);
    const suspension = wheel.suspension;
    const suspensionDelta = suspension - state.suspension0[corner];
    const steer = options.steerByCorner?.[corner] ?? 0;
    if (!Number.isFinite(steer)) throw new Error('non-finite steer for ' + corner);
    if (Math.abs(steer) > Math.abs(config.steerLimit) + 1e-9) {
      throw new Error('steer ' + steer + ' exceeds XT steerLimit ' + config.steerLimit + ' at tick ' + tick.tick);
    }

    // --- 2/3: rest + suspension travel, body-local ---
    let local;
    if (placement === 'physics') {
      // wheel.position is a world point; express it in body space.
      const d = [
        wheel.position[0] - body.position[0],
        wheel.position[1] - body.position[1],
        wheel.position[2] - body.position[2]
      ];
      local = [dot(d, body.axisX), dot(d, body.axisY), dot(d, body.axisZ)];
    } else {
      local = [
        model.restLocal[0] + suspensionAxis[0] * suspensionDelta,
        model.restLocal[1] + suspensionAxis[1] * suspensionDelta,
        model.restLocal[2] + suspensionAxis[2] * suspensionDelta
      ];
    }

    // Retail render clamp (VehicleActor.cpp:5124-5140), off by default.
    let clampApplied = false;
    const maxTravel = isFront ? options.maxTravelFront : options.maxTravelRear;
    if (options.retailClamp) {
      if (!Number.isFinite(maxTravel)) throw new Error('retailClamp needs a finite maxTravel (XT field not decoded)');
      if (suspension > maxTravel) {
        local[1] -= suspension - maxTravel;
        clampApplied = true;
      } else if (local[1] > maxTravel) {
        local[1] -= local[1] - maxTravel;
        clampApplied = true;
      }
    }

    // --- 4/5/6: steer, optional static alignment, spin ---
    let steerMatrix = rotationAxis(suspensionAxis, steer);
    if (options.applyStaticAlignment) {
      // Provisional only: retail does not add these to the mesh. Toe is about
      // the suspension axis with the physics sign ((index % 2) ? -1 : 1);
      // camber is about local Z, sign unproven outside the XT sign convention.
      const toeSign = index % 2 ? -1 : 1;
      steerMatrix = multiply(steerMatrix, rotationAxis([0, 1, 0], toeSign * (side.toe ?? 0)));
      steerMatrix = multiply(steerMatrix, rotationAxis([0, 0, 1], side.camber ?? 0));
    }
    const spin = state.spin[corner];
    const spinMatrix = rotationX(spin);
    const wheelMatrix = multiply(steerMatrix, spinMatrix);
    const nodeMatrix = multiply(bodyMatrix, multiply(translation(local[0], local[1], local[2]), wheelMatrix));

    // --- 7: caliper: same position, yaw only, no spin ---
    const axleLocal = transformDirection(steerMatrix, [1, 0, 0]);
    const upLocal = [0, 1, 0];
    const caliperZ = cross(axleLocal, upLocal); // literal retail cross, not normalised
    const caliperMatrix = multiply(bodyMatrix, multiply(
      translation(local[0], local[1], local[2]),
      rotationFromBasis(axleLocal, upLocal, caliperZ)
    ));

    // What the current slice draws: body * model rest * Rx(spin), no travel/steer.
    const currentMatrix = multiply(
      bodyMatrix,
      multiply(translation(model.restLocal[0], model.restLocal[1], model.restLocal[2]), spinMatrix)
    );

    const centre = [nodeMatrix[12], nodeMatrix[13], nodeMatrix[14]];
    const currentCentre = [currentMatrix[12], currentMatrix[13], currentMatrix[14]];
    const axleWorld = transformDirection(bodyMatrix, axleLocal);
    const forward = normalize(cross(axleWorld, body.axisY));
    const currentForward = normalize(cross(body.axisX, body.axisY));
    const tyreRadius = -model.bottomLocalY;
    const groundNormal = wheel.onGround ? wheel.groundNormal : null;
    const camberSin = groundNormal ? Math.max(-1, Math.min(1, dot(axleWorld, groundNormal))) : null;

    corners[corner] = {
      corner,
      wheelIndex: index,
      front: isFront,
      steer,
      spin,
      suspension,
      suspensionDelta,
      suspensionAxis,
      localPosition: local,
      centre,
      currentCentre,
      bottomY: centre[1] - tyreRadius,
      currentBottomY: currentCentre[1] - tyreRadius,
      tyreRadius,
      heading: forward ? headingFromForward(forward) : null,
      currentHeading: currentForward ? headingFromForward(currentForward) : null,
      headingError: forward && currentForward
        ? shortestAngle(headingFromForward(forward) - headingFromForward(currentForward))
        : null,
      camberSin,
      camberDeg: camberSin === null ? null : Math.asin(camberSin) * 180 / Math.PI,
      steerDeg: steer * 180 / Math.PI,
      matrix: nodeMatrix,
      currentMatrix,
      staticMatrix: caliperMatrix,
      caliperOrthonormality: orthonormalityError(caliperMatrix),
      caliperDeterminant: determinant3(caliperMatrix),
      clampApplied,
      axles: { local: axleLocal, world: axleWorld }
    };
  });
  return { tick: tick.tick, placement, corners };
}

/** Matrix columns as world basis vectors, for diagnostics. */
export function matrixAxes(matrix) {
  return { x: column(matrix, 0), y: column(matrix, 1), z: column(matrix, 2) };
}
