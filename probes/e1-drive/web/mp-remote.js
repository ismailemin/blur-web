// Remote-car display for the M1 two-player drive slice.
//
// The remote car is drawn through the existing ghost pipeline: the same car
// mesh and textures that are already uploaded for the local body, a second set
// of node matrices in the reserved ghost uniform slots, and no physics or
// collision. Only one remote slot exists in M1.
//
// The pose comes from the net-mvp `InterpolationBuffer` (`sampleRemote`), which
// lerps positions and slerps quaternions and never extrapolates. A bounded
// display corrector applies the M1 rule from `docs/plan/M1_ONLINE_RACE.md`:
// a delta above 0.5 m / 0.25 rad is a hard set (counted), anything smaller is
// blended over three frames. The local engine is never teleported.

import { GHOST_CORNERS } from './ghost-replay.js';
import { matrixFromQuaternion } from './ghost-replay.js';
import { multiplyMat4, rotationXMatrix } from './packet-adapter.js';
import { MP_ANGLE_THRESHOLD_RAD, MP_BLEND_TICKS, MP_POSITION_THRESHOLD_METRES } from './mp-client.js';

function quatDot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
}

function quatNormalize(q) {
  const length = Math.sqrt(quatDot(q, q));
  if (!(length > 0)) return [0, 0, 0, 1];
  return [q[0] / length, q[1] / length, q[2] / length, q[3] / length];
}

function quatSlerp(a, b, t) {
  let target = b;
  let dot = quatDot(a, target);
  if (dot < 0) { target = [-b[0], -b[1], -b[2], -b[3]]; dot = -dot; }
  if (dot > 0.9995) {
    return quatNormalize([
      a[0] + (target[0] - a[0]) * t,
      a[1] + (target[1] - a[1]) * t,
      a[2] + (target[2] - a[2]) * t,
      a[3] + (target[3] - a[3]) * t
    ]);
  }
  const theta = Math.acos(Math.min(1, Math.max(-1, dot)));
  const sinTheta = Math.sin(theta);
  const w0 = Math.sin((1 - t) * theta) / sinTheta;
  const w1 = Math.sin(t * theta) / sinTheta;
  return quatNormalize([
    a[0] * w0 + target[0] * w1,
    a[1] * w0 + target[1] * w1,
    a[2] * w0 + target[2] * w1,
    a[3] * w0 + target[3] * w1
  ]);
}

function quatAngle(a, b) {
  return 2 * Math.acos(Math.min(1, Math.abs(quatDot(a, b))));
}

/**
 * Bounded remote-display corrector. Call `update(target)` once per rendered
 * frame with the interpolated snapshot pose.
 */
export class RemoteDisplay {
  constructor({
    positionThreshold = MP_POSITION_THRESHOLD_METRES,
    angleThreshold = MP_ANGLE_THRESHOLD_RAD,
    blendTicks = MP_BLEND_TICKS
  } = {}) {
    this.positionThreshold = positionThreshold;
    this.angleThreshold = angleThreshold;
    this.blendTicks = blendTicks;
    this.reset();
  }

  reset() {
    this.position = null;
    this.quaternion = null;
    this.initialized = false;
    this.steps = 0;
    this.hardSets = 0;
    this.corrections = 0;
    this.blends = 0;
    this.lastErrorMetres = null;
    this.lastErrorRadians = null;
    this.maxErrorMetres = 0;
    this.maxErrorRadians = 0;
  }

  update(target) {
    if (!target || !Array.isArray(target.position) || !Array.isArray(target.quaternion)) return null;
    if (!this.initialized) {
      this.position = target.position.slice();
      this.quaternion = target.quaternion.slice();
      this.initialized = true;
      this.steps++;
      return this.pose(false, false, 0, 0);
    }
    const dx = target.position[0] - this.position[0];
    const dy = target.position[1] - this.position[1];
    const dz = target.position[2] - this.position[2];
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const angle = quatAngle(this.quaternion, target.quaternion);
    this.lastErrorMetres = distance;
    this.lastErrorRadians = angle;
    if (distance > this.maxErrorMetres) this.maxErrorMetres = distance;
    if (angle > this.maxErrorRadians) this.maxErrorRadians = angle;
    let hard = false;
    let blended = false;
    if (distance > this.positionThreshold || angle > this.angleThreshold) {
      this.position = target.position.slice();
      this.quaternion = target.quaternion.slice();
      this.hardSets++;
      this.corrections++;
      hard = true;
    } else if (distance > 0 || angle > 0) {
      const factor = 1 / Math.max(1, this.blendTicks);
      this.position = [
        this.position[0] + dx * factor,
        this.position[1] + dy * factor,
        this.position[2] + dz * factor
      ];
      this.quaternion = quatSlerp(this.quaternion, target.quaternion, factor);
      this.blends++;
      blended = true;
    }
    this.steps++;
    return this.pose(hard, blended, distance, angle);
  }

  pose(hard, blended, distance, angle) {
    return {
      position: this.position.slice(),
      quaternion: this.quaternion.slice(),
      hardSet: hard,
      blended,
      errorMetres: distance,
      errorRadians: angle,
      corrections: this.corrections,
      hardSets: this.hardSets,
      blends: this.blends
    };
  }
}

/**
 * Nine node matrices for the remote car, composed exactly like the packet's
 * live car and the ghost replay (body matrix, wheel rest translation, +X spin).
 *
 * M1 sends position/quaternion/speed in the E1 state shape; the snapshot has no
 * per-wheel angle, so the remote wheel spin is explicitly zero (static). This is
 * labelled in the HUD/verification record rather than guessed.
 */
export function remoteNodeMatrices(pose, wheelRest, wheelAngles = null) {
  if (!pose?.position || !pose?.quaternion) throw new Error('remote pose needs position and quaternion');
  if (!wheelRest) throw new Error('remote pose needs the car wheel rest matrices');
  const body = matrixFromQuaternion(pose.quaternion, pose.position);
  const wheels = {};
  for (const corner of GHOST_CORNERS) {
    const rest = wheelRest[corner];
    if (!rest) throw new Error('remote has no rest matrix for wheel ' + corner);
    const stationary = multiplyMat4(body, rest);
    const angle = Number.isFinite(wheelAngles?.[corner]) ? wheelAngles[corner] : 0;
    wheels[corner] = {
      static: stationary,
      spin: multiplyMat4(stationary, rotationXMatrix(angle))
    };
  }
  return { body, wheels };
}

/** Map of the nine node ids the consumer's ghost draw set expects. */
export function remoteNodeMatrixMap(pose, wheelRest, wheelAngles = null) {
  const matrices = remoteNodeMatrices(pose, wheelRest, wheelAngles);
  const map = new Map();
  map.set('e1.car.body', matrices.body);
  for (const corner of GHOST_CORNERS) {
    map.set('e1.car.wheel.' + corner + '.spin', matrices.wheels[corner].spin);
    map.set('e1.car.wheel.' + corner + '.static', matrices.wheels[corner].static);
  }
  return { map, matrices };
}

export { quatAngle, quatSlerp };
