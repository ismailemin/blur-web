// Render-packet v1.1 adapter for the E1 drive slice.
//
// Input:  one wasm state snapshot per fixed tick (position, body axes, wheels)
//         and the static geometry produced by tools/build_geometry.mjs, which
//         embeds the committed Corvette part manifest (29 parts / 80 draws /
//         four wheel groups).
// Output: a v1.1 packet whose static half is the committed River block27 +
//         Corvette geometry and whose timeline is one `updates[]` entry per
//         engine tick, plus a deterministic chase camera.
//
// The engine owns all motion. This module converts units and frames only:
//   * the car's local->world matrix is the three body axes the engine reports
//     (columns) and the chassis position;
//   * each wheel group gets the MdlDat rest-pose translation from the manifest;
//     tyre/rim/brake disc rotate about element-local +X by an angle integrated
//     from the physics wheel angular velocity (`e1_get_state().wheels[].angular`)
//     at the fixed 1/60 s step. The caliper is deliberately not rotated
//     (VehicleActor.cpp:5198);
//   * no suspension travel, steer or camber is applied: the manifest matrices
//     are rest poses and the state does not carry those per-wheel rotations;
//   * the camera is an orbit camera behind the car, so the packet validator can
//     rebuild view/projection from yaw/pitch/distance and check them;
//   * every tick is hashed with the committed canonical form.
//
// Used by the browser page (live stepping) and by tools/verify_e1_drive.mjs
// (node), so the packet the browser renders is byte-for-byte the packet the
// verifier validates, given the same tick states.

import { MATRIX_CONVENTION, cameraFromOrbit, transformPoint } from './packet-camera.mjs';
import { PACKET_KIND, PACKET_VERSION, hashOf, packetHash } from './packet-hash.js';
import { TICK_HZ } from './drive-script.js';

export const CAR_NODE_ID = 'e1.car.body';
export const WHEELS_RENDERED = true;
export const WHEEL_CORNERS = Object.freeze(['frontleft', 'frontright', 'backleft', 'backright']);

/** Column-major 16-float multiply, matching WGSL mat4x4f * vec4f. */
function multiplyMat4(a, b) {
  const out = new Array(16);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[column * 4 + k];
      out[column * 4 + row] = sum;
    }
  }
  return out;
}

/** Rotation about element-local +X (the proven wheel axle). */
function rotationXMatrix(angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1];
}

export function wheelNodeId(corner, spinning) {
  return `e1.car.wheel.${corner}.${spinning ? 'spin' : 'static'}`;
}

/** Column-major rigid matrix from the engine's three body axes + position. */
export function carMatrix(state) {
  const [px, py, pz] = state.position;
  const [xx, xy, xz] = state.axisX;
  const [yx, yy, yz] = state.axisY;
  const [zx, zy, zz] = state.axisZ;
  return [xx, xy, xz, 0, yx, yy, yz, 0, zx, zy, zz, 0, px, py, pz, 1];
}

/** AABB of a local AABB under an affine matrix (8 corners). */
export function boundsUnderMatrix(local, matrix) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let corner = 0; corner < 8; corner++) {
    const point = [
      corner & 1 ? local.max[0] : local.min[0],
      corner & 2 ? local.max[1] : local.min[1],
      corner & 4 ? local.max[2] : local.min[2]
    ];
    const moved = transformPoint(matrix, point);
    for (let axis = 0; axis < 3; axis++) {
      if (moved[axis] < min[axis]) min[axis] = moved[axis];
      if (moved[axis] > max[axis]) max[axis] = moved[axis];
    }
  }
  return { min, max };
}

const shortestAngle = (delta) => {
  let value = delta;
  while (value > Math.PI) value -= Math.PI * 2;
  while (value < -Math.PI) value += Math.PI * 2;
  return value;
};

/**
 * Chase camera. The eye sits behind the car along its own longitudinal axis
 * (the engine's local +Z, which is `state.axisZ`), looking at the chassis.
 * Yaw/pitch follow the car with a fixed per-tick lag so the camera is smooth but
 * still a pure function of the tick sequence (no wall-clock time anywhere).
 */
export class ChaseCamera {
  constructor(intrinsics, options = {}) {
    this.intrinsics = intrinsics;
    this.distance = options.distance ?? 9.0;
    this.height = options.height ?? 2.4;
    this.lookHeight = options.lookHeight ?? 1.0;
    this.smoothing = options.smoothing ?? 0.18;
    this.yaw = null;
    this.pitch = Math.asin(this.height / Math.hypot(this.distance, this.height));
    this.orbitDistance = Math.hypot(this.distance, this.height);
  }

  /** Desired yaw/pitch for a state, measured from the target to the desired eye. */
  desired(state) {
    const [fx, , fz] = state.axisZ;
    const horizontal = Math.hypot(fx, fz);
    // Behind the car: the forward axis points away from the eye.
    const yaw = Math.atan2(-fx, -fz);
    const pitch = Math.asin(this.height / Math.hypot(this.distance, this.height));
    return { yaw, pitch, horizontal, distance: this.orbitDistance };
  }

  /** Advance the lag by one tick and return the packet camera for this tick. */
  update(state) {
    const want = this.desired(state);
    if (this.yaw === null) {
      this.yaw = want.yaw;
      this.pitch = want.pitch;
    } else {
      this.yaw += shortestAngle(want.yaw - this.yaw) * this.smoothing;
      this.pitch += (want.pitch - this.pitch) * this.smoothing;
    }
    const target = [state.position[0], state.position[1] + this.lookHeight, state.position[2]];
    const built = cameraFromOrbit({
      target,
      distance: this.orbitDistance,
      yaw: this.yaw,
      pitch: this.pitch,
      near: this.intrinsics.near,
      far: this.intrinsics.far,
      verticalFovRadians: this.intrinsics.verticalFovRadians,
      aspect: this.intrinsics.aspect
    });
    return {
      mode: 'orbit',
      position: built.position,
      target,
      up: this.intrinsics.up.slice(),
      view: built.view,
      projection: built.projection,
      near: this.intrinsics.near,
      far: this.intrinsics.far,
      verticalFovRadians: this.intrinsics.verticalFovRadians,
      aspect: this.intrinsics.aspect,
      matrixConvention: MATRIX_CONVENTION,
      orbit: { yaw: this.yaw, pitch: this.pitch, distance: this.orbitDistance }
    };
  }
}

/**
 * Build the static packet and an empty timeline. `tick0` is the settled state the
 * engine reports after reset; every draw reference frame comes from it.
 */
export function createSession(geometry, tick0, options = {}) {
  const intrinsics = geometry.cameraIntrinsics;
  const camera = new ChaseCamera(intrinsics, options.camera);
  const reference = carMatrix(tick0);
  const cameraTick0 = camera.update(tick0);

  const levelDraws = geometry.levelDraws.map((draw) => ({
    ...draw,
    world: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    worldKind: 'baked-into-mesh'
  }));

  if (geometry.version !== 2 || !Array.isArray(geometry.carNodes) ||
      !Array.isArray(geometry.wheelGroups) || geometry.wheelGroups.length !== 4) {
    throw new Error('geometry does not carry the committed car-part manifest; rebuild it with ' +
      '`node probes/e1-drive/tools/build_geometry.mjs`');
  }
  const wheelByCorner = new Map(geometry.wheelGroups.map((group) => [group.corner, group]));
  for (const corner of WHEEL_CORNERS) {
    if (!wheelByCorner.has(corner)) throw new Error('geometry has no wheel group for ' + corner);
  }
  const carMeshId = geometry.carDraws[0]?.meshId;
  if (!carMeshId) throw new Error('geometry has no car draws');

  // Draws keep their packet ranges and gain the manifest identity and the node
  // that moves them. Wheel draws sit on their group's rest-pose translation so
  // their static (tick-0) world matrix is already correct before any update.
  const carDraws = geometry.carDraws.map((draw) => {
    const { localBounds, ...rest } = draw;
    const corner = typeof draw.renderPartId === 'string' && draw.renderPartId.startsWith('wheel.')
      ? draw.renderPartId.slice('wheel.'.length) : null;
    const world = corner ? multiplyMat4(reference, wheelByCorner.get(corner).matrixColumnMajor) : reference;
    return {
      ...rest,
      world,
      worldKind: 'packet-transform',
      bounds: boundsUnderMatrix(localBounds, world)
    };
  });

  const carNodes = geometry.carNodes.map((node) => ({ ...node, drawIds: node.drawIds.slice() }));
  const carDrawIds = new Set(carDraws.map((draw) => draw.id));
  const owned = new Set();
  for (const node of carNodes) {
    if (node.meshId !== carMeshId) throw new Error('node ' + node.id + ' names mesh ' + node.meshId + ', expected ' + carMeshId);
    for (const drawId of node.drawIds) {
      if (!carDrawIds.has(drawId)) throw new Error('node ' + node.id + ' references unknown car draw ' + drawId);
      if (owned.has(drawId)) throw new Error('car draw ' + drawId + ' is moved by more than one node');
      owned.add(drawId);
    }
  }
  if (owned.size !== carDraws.length) {
    throw new Error('nodes cover ' + owned.size + ' of ' + carDraws.length + ' car draws');
  }

  // Per-tick wheel spin. The state carries angular velocity, not an angle, so the
  // adapter integrates it at the fixed tick duration. Starting from zero and
  // advancing only when the tick increases makes the angle a pure function of
  // the state sequence (two runs produce the same matrices).
  const wheelSpin = {
    angle: Object.fromEntries(WHEEL_CORNERS.map((corner) => [corner, 0])),
    cornerByWheelIndex: null,
    lastTick: null
  };

  const meshes = geometry.meshes.map((mesh) => ({
    id: mesh.id,
    storage: mesh.storage,
    vertexCount: mesh.vertexCount,
    indexCount: mesh.indexCount,
    positions: mesh.positions,
    indices: mesh.indices,
    positionsSha256: mesh.positionsSha256,
    indicesSha256: mesh.indicesSha256,
    coordinateSpace: mesh.coordinateSpace,
    source: mesh.source
  }));

  const vertexTotal = meshes.reduce((sum, mesh) => sum + mesh.vertexCount, 0);
  const triangleTotal = meshes.reduce((sum, mesh) => sum + mesh.indexCount / 3, 0);

  // The car identity the engine actually decoded. Optional, so a caller that
  // does not pass it produces exactly the single-car packet this slice shipped
  // before the roster existed.
  const car = options.car
    ? {
        name: options.car.name,
        slug: options.car.slug ?? null,
        recordIndex: options.car.recordIndex ?? null,
        recordId: options.car.recordId ?? null,
        drivetrain: options.car.drivetrain ?? null,
        mass: options.car.mass ?? null,
        fieldsSha256: options.car.fieldsSha256 ?? null,
        bodyMesh: 'corvette.c3.race.body',
        bodyMeshReason:
          'the committed render packet carries one vehicle body (the Corvette C3 race body); every roster car is ' +
          'drawn with it because no per-car body mesh is imported in this slice. The physics is the record named above',
        source: 'RP_CarDynamics record decoded by engine/harness/t005d-vehicle/car_xt.py'
      }
    : null;

  const packet = {
    kind: PACKET_KIND,
    version: PACKET_VERSION,
    generator: {
      name: 'blur-e1-drive-slice',
      version: '1.0.0',
      producers: [
        {
          id: 'geometry',
          tool: 'probes/e1-drive/tools/build_geometry.mjs',
          source: geometry.source.packet,
          sourcePacketHash: geometry.source.packetHash,
          outputSha256: geometry.source.packetSha256
        },
        {
          id: 'parts',
          tool: 'probes/e1-drive/tools/build_geometry.mjs',
          source: geometry.manifest?.path ?? null,
          sourceSha256: geometry.manifest?.sha256 ?? null,
          note: 'part ids, draw ranges, wheel groups and rest-pose translations copied from the committed Corvette part manifest'
        },
        {
          id: 'simulation',
          tool: 'probes/e1-drive/module/e1_drive.wasm',
          api: 'create/reset/set_input/step/get_state',
          note: 'one C_Scene::Simulate(1/60) per packet tick; wheel spin angle integrated from the state angular velocity'
        }
      ]
    },
    tick: 0,
    alpha: 0,
    tickDurationSeconds: 1 / TICK_HZ,
    camera: cameraTick0,
    lights: [geometry.light],
    meshes,
    materials: geometry.materials,
    draws: levelDraws.concat(carDraws),
    placedObjects: [{
      meshId: 'corvette.c3.race.body',
      placement: 'engine-spawn-transform',
      world: reference,
      reason:
        'tick 0 is the pose the engine reports after its 180-tick settle at the ground-probed ' +
        'spawn point; the translation and the three body axes come from the simulation, not from a chosen anchor'
    }],
    nodes: carNodes,
    updates: [],
    diagnostics: {
      drawCount: levelDraws.length + carDraws.length,
      meshCount: meshes.length,
      vertexTotal,
      triangleTotal,
      instancesEmitted: geometry.levelInstances?.emitted ?? levelDraws.length,
      instancesOmitted: geometry.levelInstances?.omitted ?? 0,
      culled: 0,
      materialsApplied: false,
      lighting: 'diagnostic-directional',
      scope:
        'River block27/node253 supported instances plus the Corvette C3 race body drawn as 29 manifest parts / ' +
        '80 draws with four spinning wheel groups; the body and wheel poses come from the wasm ' +
        'RacingPhysics/Gravity step, materials and lighting are diagnostic',
      sequence: {
        tickCount: 0,
        tickHz: TICK_HZ,
        motion: 'physics',
        motionReason:
          'each tick is one C_Scene::Simulate(1/60) of the real RacingPhysics vehicle on the River collision mesh ' +
          '(usa_la_river/Level.levelphysics); no parametric path, no keyframes, no synthetic motion',
        alphaSource: 'per-tick alpha is 0 (tick-exact); the consumer supplies its own fixed-step alpha',
        nodeIds: carNodes.map((node) => node.id),
        staticDrawCount: levelDraws.length,
        movedDrawCount: carDraws.length,
        firstTickHash: null,
        lastTickHash: null
      },
      extras: {
        drive: {
          simulation: 'wasm32 RacingPhysics + Gravity (T-005d 186-object closure)',
          stepSeconds: 1 / TICK_HZ,
          spawn: options.spawn ?? null,
          script: '2 s throttle, 2 s coast, 1 s brake (probes/e1-drive/web/drive-script.js)',
          camera: 'chase orbit behind the car, yaw follows with a fixed per-tick lag',
          stateFields: ['position', 'axisX', 'axisY', 'axisZ', 'speed', 'contacts', 'wheels'],
          ...(car ? { car } : {})
        },
        parts: {
          manifest: geometry.manifest ?? null,
          partCount: geometry.carParts?.length ?? 0,
          drawCount: carDraws.length,
          nodeCount: carNodes.length,
          nodes: carNodes.map((node) => ({ id: node.id, drawCount: node.drawIds.length })),
          bodyDrawCount: carDraws.filter((draw) => draw.nodeId === CAR_NODE_ID).length,
          wheelDrawCount: carDraws.filter((draw) => draw.nodeId !== CAR_NODE_ID).length,
          colours:
            'diagnostic per-part colours for visual debugging only (materialsApplied:false); ' +
            'they are not game materials, paint or texture pixels'
        },
        wheels: {
          rendered: WHEELS_RENDERED,
          wheelGroupCount: geometry.wheelGroups.length,
          wheelNodes: carNodes.filter((node) => node.id !== CAR_NODE_ID).map((node) => node.id),
          spinAxis: 'element-local +X',
          spinAxisSource: 'wheel/rim local bounds are thin on X; VehicleActor.cpp:5158-5197 spins about wheelMatrix.AX()',
          spinMembers: geometry.wheelGroups[0]?.spinMembers ?? ['tyre', 'rim', 'brakeDisc'],
          staticMembers: geometry.wheelGroups[0]?.staticMembers ?? ['brakeCaliper'],
          angleSource:
            'integrated at 1/60 s from e1_get_state().wheels[].angular (physics wheel angular velocity), ' +
            'starting at 0 on the settled tick; each wheel is assigned to the nearest manifest wheel translation ' +
            'in body-local space',
          restPose:
            'wheel group placement is the MdlDat rest-pose translation from the part manifest; no suspension travel, ' +
            'steer or camber is applied because the state does not carry those per-wheel rotations',
          caliper:
            'brake calipers share the wheel rest-pose translation but are not rotated (VehicleActor.cpp:5198, ' +
            '"Brake calipers mustn\'t rotate")',
          reason:
            'the committed scene reader returns one 80-draw car mesh that contains the wheel geometry; the manifest ' +
            'proves which draws are tyre/rim/disc/caliper and where each wheel group sits'
        },
        surfaces: {
          surfaceMappingsApplied: false,
          reason: 'RP_SurfaceMappingList is not installed; engine grip/rolling/MI scales are the documented neutral values'
        },
        track: {
          id: geometry.meshes[2]?.id ?? null,
          source: 'usa_la_river/Level.levelphysics through the collision-oracle reference parser',
          triangles: (geometry.meshes[2]?.indexCount ?? 0) / 3,
          reason:
            'the committed River draw set is props near the road, not the road surface; this draw is the collision ' +
            'surface the wheels actually trace, labelled as diagnostic collision geometry (no material binding)'
        },
        carBodyShape: 'box-from-XT-geometry',
        carBodyShapeReason: 'retail builds the gravity body from the model import; this slice uses the T-005d box proxy',
        meshFrame:
          'the car mesh is drawn in the engine body frame; the retail mesh-to-body alignment is not recovered ' +
          '(the model import is out of scope), so the body may be rotated/offset relative to the chassis'
      },
      approximations: [
        'level and vehicle materials are not applied; car parts use a diagnostic per-part colour, all other draws use a neutral albedo, under one directional light',
        'no shadow, post-process, particle or effect pass exists in this consumer',
        'face normals come from screen-space derivatives of the world position, not from original vertex normals',
        'the car mesh is aligned to the engine body frame directly; the retail mesh import and its offset are not recovered',
        'wheel placement uses the manifest rest-pose translation; the spin angle is integrated from the physics wheel angular velocity, not read as an angle',
        'the tyre/rim/disc spin marker is a diagnostic band, not a material or a texture',
        'grip, rolling friction and MI scales are the engine neutral values because no surface mapping list is installed'
      ],
      notRecovered: [
        'level material list to shader binding',
        'original level and vehicle lighting rigs',
        'vehicle paint lookup texture and runtime light blends',
        'per-car body meshes (every roster car is drawn with the Corvette C3 manifest)',
        'runtime per-wheel matrices (suspension, steer, camber), higher LODs and damage states',
        'engine asset streaming, culling and draw-list production (this slice drives one car on one loaded block)',
        'level blocks 26, 32 and 31 instances'
      ],
      limits: [
        car
          ? 'one car at a time, selected from the RP_CarDynamics roster at runtime: not a race, a game loop or a full level'
          : 'one car, one loaded River collision mesh, one camera: not a race, a game loop or a full level',
        'no audio, no HUD beyond diagnostics, no multiplayer, no race rules',
        'the 29 parts are the Corvette C3 manifest for every roster car; no per-car body or wheel mesh is imported',
        'packet v1.1 is JSON with inline geometry; it is not an engine draw-list integration',
        'the geometry is a spike fixture (block27/node253) while the simulation runs on the whole level physics mesh, ' +
          'so the car can leave the drawn area if it drives far enough',
        'native-vs-wasm numeric parity is blocked by the DirectX SDK (T-007-vehicle-physics.md §7)'
      ]
    }
  };

  // Wheel nodes in a fixed order so the per-tick matrix list is deterministic.
  const wheelNodesInOrder = [];
  for (const corner of WHEEL_CORNERS) {
    for (const spinning of [true, false]) {
      const id = wheelNodeId(corner, spinning);
      if (carNodes.some((node) => node.id === id)) wheelNodesInOrder.push({ id, corner, spinning });
    }
  }

  /**
   * Assign each physics wheel to a manifest wheel corner by the nearest rest
   * translation in body-local space. The state does not name its wheel order, so
   * this uses the position the engine reports instead of assuming an order.
   */
  function mapWheelsToCorners(state) {
    if (!Array.isArray(state.wheels) || state.wheels.length !== 4) {
      throw new Error('state has no four wheel records; the manifest wheels cannot be placed');
    }
    const [px, py, pz] = state.position;
    const ax = state.axisX;
    const ay = state.axisY;
    const az = state.axisZ;
    return state.wheels.map((wheel) => {
      if (!Array.isArray(wheel.position)) throw new Error('wheel record has no position');
      const dx = wheel.position[0] - px;
      const dy = wheel.position[1] - py;
      const dz = wheel.position[2] - pz;
      const localX = ax[0] * dx + ax[1] * dy + ax[2] * dz;
      const localZ = az[0] * dx + az[1] * dy + az[2] * dz;
      let best = null;
      let bestDistance = Infinity;
      for (const corner of WHEEL_CORNERS) {
        const translation = wheelByCorner.get(corner).translation;
        const distance = (localX - translation[0]) ** 2 + (localZ - translation[2]) ** 2;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = corner;
        }
      }
      return best;
    });
  }

  /** Integrate the physics wheel angular velocity into a per-corner spin angle. */
  function advanceWheelSpin(state) {
    if (!wheelSpin.cornerByWheelIndex) wheelSpin.cornerByWheelIndex = mapWheelsToCorners(state);
    if (wheelSpin.lastTick === null) {
      wheelSpin.lastTick = state.tick;
      return;
    }
    const deltaTicks = state.tick - wheelSpin.lastTick;
    if (deltaTicks <= 0) return;
    const seconds = deltaTicks / TICK_HZ;
    state.wheels.forEach((wheel, index) => {
      const corner = wheelSpin.cornerByWheelIndex[index];
      if (!corner) throw new Error('no manifest wheel corner for physics wheel ' + index);
      if (!Number.isFinite(wheel.angular)) {
        throw new Error('non-finite wheel angular velocity at tick ' + state.tick + ' wheel ' + index);
      }
      wheelSpin.angle[corner] += wheel.angular * seconds;
    });
    wheelSpin.lastTick = state.tick;
  }

  const session = {
    packet,
    camera,
    tick0,
    lastState: tick0,
    wheelSpin,
    // Per-tick copy of the integrated angles, indexed by tick, so the page can
    // publish the angle of the tick it actually renders (the live loop appends
    // one tick ahead of the displayed frame).
    wheelAnglesByTick: [],

    appendState(state) {
      advanceWheelSpin(state);
      const body = carMatrix(state);
      const matrices = [{ nodeId: CAR_NODE_ID, world: body }];
      for (const node of wheelNodesInOrder) {
        const rest = wheelByCorner.get(node.corner).matrixColumnMajor;
        let world = multiplyMat4(body, rest);
        // Only tyre/rim/brake disc rotate; the caliper stays at the rest pose.
        if (node.spinning) world = multiplyMat4(world, rotationXMatrix(wheelSpin.angle[node.corner]));
        matrices.push({ nodeId: node.id, world });
      }
      const update = {
        tick: state.tick,
        alpha: 0,
        camera: state.tick === 0 ? cameraTick0 : this.camera.update(state),
        matrices
      };
      update.hash = hashOf(update);
      packet.updates.push(update);
      this.wheelAnglesByTick.push({ tick: state.tick, angles: { ...wheelSpin.angle } });
      this.lastState = state;
      return update;
    },

    finalise() {
      packet.camera = packet.updates[0].camera;
      packet.tick = packet.updates[0].tick;
      packet.alpha = packet.updates[0].alpha;
      packet.diagnostics.sequence.tickCount = packet.updates.length;
      packet.diagnostics.sequence.firstTickHash = packet.updates[0].hash;
      packet.diagnostics.sequence.lastTickHash = packet.updates[packet.updates.length - 1].hash;
      packet.hash = packetHash(packet);
      return packet;
    }
  };
  return session;
}
