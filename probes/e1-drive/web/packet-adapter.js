// Render-packet v1.1 adapter for the E1 drive slice.
//
// Input:  one wasm state snapshot per fixed tick (position, body axes, wheels).
// Output: a v1.1 packet whose static half is the committed River block27 +
//         Corvette geometry and whose timeline is one `updates[]` entry per
//         engine tick, plus a deterministic chase camera.
//
// The engine owns all motion. This module converts units and frames only:
//   * the car's local->world matrix is the three body axes the engine reports
//     (columns) and the chassis position;
//   * the camera is an orbit camera behind the car, so the packet validator can
//     rebuild view/projection from yaw/pitch/distance and check them;
//   * every tick is hashed with the committed canonical form.
//
// Used by the browser page (live stepping) and by tools/run_scripted.mjs (node),
// so the packet the browser renders is byte-for-byte the packet the verifier
// validates, given the same tick states.

import { MATRIX_CONVENTION, cameraFromOrbit, transformPoint } from './packet-camera.mjs';
import { PACKET_KIND, PACKET_VERSION, hashOf, packetHash } from './packet-hash.js';
import { TICK_HZ } from './drive-script.js';

export const CAR_NODE_ID = 'e1.car.body';
export const WHEELS_RENDERED = false;

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

  const carDraws = geometry.carDraws.map((draw) => {
    const { localBounds, ...rest } = draw;
    return {
      ...rest,
      world: reference,
      worldKind: 'packet-transform',
      bounds: boundsUnderMatrix(localBounds, reference)
    };
  });

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
          id: 'simulation',
          tool: 'probes/e1-drive/module/e1_drive.wasm',
          api: 'create/reset/set_input/step/get_state',
          note: 'one C_Scene::Simulate(1/60) per packet tick'
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
    nodes: [{
      id: CAR_NODE_ID,
      meshId: 'corvette.c3.race.body',
      drawIds: carDraws.map((draw) => draw.id),
      reason: 'single rigid vehicle body: all 80 car draws share the engineered chassis transform'
    }],
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
        'River block27/node253 supported instances plus the Corvette C3 race body; the body pose comes from the ' +
        'wasm RacingPhysics/Gravity step, materials and lighting are diagnostic',
      sequence: {
        tickCount: 0,
        tickHz: TICK_HZ,
        motion: 'physics',
        motionReason:
          'each tick is one C_Scene::Simulate(1/60) of the real RacingPhysics vehicle on the River collision mesh ' +
          '(usa_la_river/Level.levelphysics); no parametric path, no keyframes, no synthetic motion',
        alphaSource: 'per-tick alpha is 0 (tick-exact); the consumer supplies its own fixed-step alpha',
        nodeIds: [CAR_NODE_ID],
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
        wheels: {
          rendered: WHEELS_RENDERED,
          reason:
            'no Corvette wheel mesh is recovered by the scene reader (the committed packet has body draws only); ' +
            'wheel contact, suspension, spin and position are carried in the state/HUD, not drawn'
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
        'level and vehicle materials are not applied; every draw is shaded with a neutral albedo under one directional light',
        'no shadow, post-process, particle or effect pass exists in this consumer',
        'face normals come from screen-space derivatives of the world position, not from original vertex normals',
        'the car mesh is aligned to the engine body frame directly; the retail mesh import and its offset are not recovered',
        'wheels are not drawn: no wheel mesh is in scope (state-only)',
        'grip, rolling friction and MI scales are the engine neutral values because no surface mapping list is installed'
      ],
      notRecovered: [
        'level material list to shader binding',
        'original level and vehicle lighting rigs',
        'vehicle paint lookup texture and runtime light blends',
        'wheel meshes, higher LODs and damage states',
        'engine asset streaming, culling and draw-list production (this slice drives one car on one loaded block)',
        'level blocks 26, 32 and 31 instances'
      ],
      limits: [
        car
          ? 'one car at a time, selected from the RP_CarDynamics roster at runtime: not a race, a game loop or a full level'
          : 'one car, one loaded River collision mesh, one camera: not a race, a game loop or a full level',
        'no audio, no HUD beyond diagnostics, no multiplayer, no race rules',
        'packet v1.1 is JSON with inline geometry; it is not an engine draw-list integration',
        'the geometry is a spike fixture (block27/node253) while the simulation runs on the whole level physics mesh, ' +
          'so the car can leave the drawn area if it drives far enough',
        'native-vs-wasm numeric parity is blocked by the DirectX SDK (T-007-vehicle-physics.md §7)'
      ]
    }
  };

  const session = {
    packet,
    camera,
    tick0,
    lastState: tick0,

    appendState(state) {
      const update = {
        tick: state.tick,
        alpha: 0,
        camera: state.tick === 0 ? cameraTick0 : this.camera.update(state),
        matrices: [{ nodeId: CAR_NODE_ID, world: carMatrix(state) }]
      };
      update.hash = hashOf(update);
      packet.updates.push(update);
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
