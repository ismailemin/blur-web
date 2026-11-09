// Render-packet v1.1 adapter for the E1 drive slice.
//
// Input:  one wasm state snapshot per fixed tick (position, body axes, wheels)
//         and the static geometry produced by tools/build_geometry.mjs, which
//         embeds one real body/wheel manifest per roster car.
// Output: a v1.1 packet whose static half is the committed River block27 geometry,
//         the real River track visual (committed level_inspect direct draws) and
//         the selected car's body, and whose timeline is one `updates[]` entry per
//         engine tick, plus a deterministic chase camera. The collision surface is
//         carried in `physicsSurfaces` with visible:false as physics provenance.
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
//     rebuild view/projection from yaw/pitch/distance and check them; its
//     distance is collision-limited against the visible static geometry and the
//     per-tick request/hit is recorded in `camera.occlusion`;
//   * every tick is hashed with the committed canonical form.
//
// Used by the browser page (live stepping) and by tools/verify_e1_drive.mjs
// (node), so the packet the browser renders is byte-for-byte the packet the
// verifier validates, given the same tick states.

import { MATRIX_CONVENTION, cameraFromOrbit, transformPoint } from './packet-camera.mjs';
import { PACKET_KIND, PACKET_VERSION, hashOf, packetHash } from './packet-hash.js';
import { buildOccluder } from './camera-occlusion.js';
import { TICK_HZ } from './drive-script.js';
// The decoded retail car material table (paint, glass, emissive, alloy). Every
// value is copied from the retail XT records by probes/car-materials.
import { materialsFor } from '../../car-materials/runtime-materials.mjs';

export const CAR_NODE_ID = 'e1.car.body';
export const WHEELS_RENDERED = true;
export const WHEEL_CORNERS = Object.freeze(['frontleft', 'frontright', 'backleft', 'backright']);

/**
 * The body/mesh/parts record for one roster car. `geometry.json` v3 carries all
 * five real bodies; a session draws exactly one of them, so the packet uploads
 * one car mesh and never a car it is not driving.
 */
export function resolveCarBody(geometry, slug) {
  if (!geometry || geometry.version !== 6 || !geometry.carBodies) {
    throw new Error('geometry does not carry per-car bodies, the track visual, the level-instance ' +
      'prop UV0/BC1 pack, the static albedo textures and the P52 per-car albedo textures with their ' +
      'UV0 stream; rebuild it with `node probes/e1-drive/tools/build_geometry.mjs`');
  }
  const key = slug ?? geometry.defaultCar;
  const body = geometry.carBodies[key];
  if (!body) {
    throw new Error('geometry has no body for ' + JSON.stringify(key) + '; available: ' +
      Object.keys(geometry.carBodies).join(', '));
  }
  return body;
}

/** Column-major 16-float multiply, matching WGSL mat4x4f * vec4f. */
export function multiplyMat4(a, b) {
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

/** Rotation about element-local +X (the proven wheel axle). Exported so the
 *  ghost replay composes wheel matrices with the same function as the live car. */
export function rotationXMatrix(angle) {
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

/** Unit vector from the orbit target toward the eye, matching `orbitView`. */
function orbitDirection(yaw, pitch) {
  return [Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch), Math.cos(pitch) * Math.cos(yaw)];
}

/**
 * Chase camera. The eye sits behind the car along its own longitudinal axis
 * (the engine's local +Z, which is `state.axisZ`), looking at the chassis.
 * Yaw/pitch follow the car with a fixed per-tick lag so the camera is smooth but
 * still a pure function of the tick sequence (no wall-clock time anywhere).
 *
 * Occlusion (P36): the desired eye is the natural chase distance, but the car
 * can be in front of a prop or an embankment. Every tick casts the segment from
 * the aim point (`position + lookHeight`) to that desired eye against the
 * visible static geometry (level props + real track visual, see
 * `camera-occlusion.js`). If the segment is blocked, the eye is placed `margin`
 * metres in front of the first hit instead of behind it. The resulting distance
 * is a pure function of the state sequence too:
 *
 *   * pull-in is immediate — the eye is never left behind a surface for a tick;
 *   * push-out is eased by `recovery` per tick, so leaving a prop does not pop.
 *
 * No continuous collision: one cast per packet tick at the resolved yaw/pitch;
 * nothing is swept between ticks. `camera.occlusion` records the requested
 * distance, the used distance and the hit for every tick.
 */
export class ChaseCamera {
  constructor(intrinsics, options = {}) {
    this.intrinsics = intrinsics;
    this.distance = options.distance ?? 9.0;
    this.height = options.height ?? 2.4;
    this.lookHeight = options.lookHeight ?? 1.0;
    this.smoothing = options.smoothing ?? 0.18;
    // Diagnostics only (?camyaw=): rotates the chase eye around the car so a
    // screenshot can show the side/wheels. Never set by the default page.
    this.yawOffset = options.yawOffset ?? 0;
    // Occlusion. `occluder:null` or `occlusion:false` reproduces the pre-P36
    // camera for diagnostics; the verifier re-casts the desired eye itself, so it
    // does not have to trust this switch.
    this.occluder = options.occluder ?? null;
    this.occlusion = (options.occlusion ?? true) && this.occluder !== null;
    this.occlusionMargin = options.occlusionMargin ?? 0.4;
    // Hard floor only; a surface closer than margin + floor collapses the eye
    // further rather than leaving it behind the surface (see resolveDistance).
    this.occlusionMinimum = options.occlusionMinimum ?? 0.05;
    this.occlusionRecovery = options.occlusionRecovery ?? 0.08;
    // A hit closer than this to the aim point is inside the car's own rear
    // envelope: the car is passing through the prop, so no eye distance can put
    // the surface between the car and the camera and still keep the car in front
    // of it. Moving the eye there would put it in the car, so the distance is
    // held and the tick is recorded as nearField instead of being "resolved".
    this.occlusionNearField = options.occlusionNearField ?? 3.4;
    this.yaw = null;
    this.pitch = Math.asin(this.height / Math.hypot(this.distance, this.height));
    this.orbitDistance = Math.hypot(this.distance, this.height);
    this.resolvedDistance = null;
  }

  /** Desired yaw/pitch for a state, measured from the target to the desired eye. */
  desired(state) {
    const [fx, , fz] = state.axisZ;
    const horizontal = Math.hypot(fx, fz);
    // Behind the car: the forward axis points away from the eye.
    const yaw = Math.atan2(-fx, -fz) + this.yawOffset;
    const pitch = Math.asin(this.height / Math.hypot(this.distance, this.height));
    return { yaw, pitch, horizontal, distance: this.orbitDistance };
  }

  /**
   * Distance the eye may use this tick, and the cast result that produced it.
   * Exposed so the verifier can compare the resolved camera with the unoccluded
   * one without duplicating the smoothing rule.
   */
  resolveDistance(target) {
    const direction = orbitDirection(this.yaw, this.pitch);
    const desiredEye = [
      target[0] + direction[0] * this.orbitDistance,
      target[1] + direction[1] * this.orbitDistance,
      target[2] + direction[2] * this.orbitDistance
    ];
    let allowed = this.orbitDistance;
    let hit = null;
    let nearField = false;
    if (this.occlusion) {
      hit = this.occluder.castSegment(target, desiredEye);
      if (hit) {
        if (hit.distance <= this.occlusionNearField) {
          // The prop crosses the car itself. Hold the current distance (a
          // pull-in would be inside the car) and say so in the record.
          nearField = true;
          allowed = this.resolvedDistance ?? this.orbitDistance;
        } else {
          // In front of the surface, never behind it. Framing is secondary to
          // not putting the eye inside geometry, so a surface closer than
          // margin + floor collapses the eye further instead of clamping past it.
          allowed = Math.max(this.occlusionMinimum, hit.distance - this.occlusionMargin);
        }
      }
    }
    if (this.resolvedDistance === null) this.resolvedDistance = allowed;
    else if (nearField) this.resolvedDistance = allowed; // held
    else if (allowed <= this.resolvedDistance) this.resolvedDistance = allowed; // pull in at once
    else this.resolvedDistance += (allowed - this.resolvedDistance) * this.occlusionRecovery;
    return { allowed, hit, nearField, distance: this.resolvedDistance };
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
    const resolved = this.resolveDistance(target);
    const built = cameraFromOrbit({
      target,
      distance: resolved.distance,
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
      orbit: { yaw: this.yaw, pitch: this.pitch, distance: resolved.distance },
      occlusion: {
        enabled: this.occlusion,
        requestedDistance: this.orbitDistance,
        distance: resolved.distance,
        blocked: resolved.hit !== null,
        nearField: resolved.nearField,
        hitDistance: resolved.hit ? resolved.hit.distance : null,
        hitMesh: resolved.hit ? resolved.hit.meshId : null,
        marginMetres: this.occlusionMargin,
        nearFieldMetres: this.occlusionNearField
      }
    };
  }
}

/**
 * Build the static packet and an empty timeline. `tick0` is the settled state the
 * engine reports after reset; every draw reference frame comes from it.
 */
export function createSession(geometry, tick0, options = {}) {
  const intrinsics = geometry.cameraIntrinsics;
  // The occluder is built once per geometry object; every session (browser page,
  // node verifier run A/B, every car) reuses the same tree.
  const occluder = options.occluder ?? buildOccluder(geometry);
  const camera = new ChaseCamera(intrinsics, { ...(options.camera ?? {}), occluder });
  const reference = carMatrix(tick0);
  const cameraTick0 = camera.update(tick0);

  // The body this session draws: the selected roster car's own real mesh.
  const body = resolveCarBody(geometry, options.car?.slug);
  if (!Array.isArray(body.carNodes) || !Array.isArray(body.wheelGroups) || body.wheelGroups.length !== 4) {
    throw new Error('geometry body ' + body.slug + ' does not carry four wheel groups');
  }
  // Map package branch (M3): `geometry.mapRender` means the static half comes
  // from a map render package (one merged mesh + one opaque draw list + its
  // texture pack) instead of the River level-props/track-visual pair. The River
  // path below is untouched when `mapRender` is absent.
  const mapRender = geometry.mapRender ?? null;
  let levelDraws;
  let trackVisual;
  let trackMesh;
  let collisionSurface;
  let trackDraws;
  let staticDraws;
  let physicsSurfaces;
  if (mapRender) {
    levelDraws = [];
    trackVisual = mapRender;
    if (mapRender.label !== geometry.map?.renderLabel || !Array.isArray(mapRender.draws) ||
        mapRender.draws.length === 0) {
      throw new Error('geometry mapRender is not the committed map direct-draw package');
    }
    trackMesh = geometry.meshes.find((mesh) => mesh.id === mapRender.meshId);
    if (!trackMesh) throw new Error('map render names a missing mesh ' + mapRender.meshId);
    collisionSurface = mapRender.collisionSurface;
    if (!collisionSurface || collisionSurface.visible !== false || !collisionSurface.mesh) {
      throw new Error('map package is missing the hidden physics collision surface');
    }
    physicsSurfaces = [{
      id: collisionSurface.id,
      meshId: collisionSurface.meshId,
      visible: false,
      physicsOnly: true,
      vertexCount: collisionSurface.vertexCount,
      triangleCount: collisionSurface.triangleCount,
      bounds: collisionSurface.bounds,
      source: collisionSurface.source,
      reason: collisionSurface.reason,
      mesh: collisionSurface.mesh,
      draw: {
        ...collisionSurface.draw,
        world: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
      }
    }];
    trackDraws = mapRender.draws.map((draw) => ({
      ...draw,
      world: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      worldKind: 'baked-into-mesh'
    }));
    staticDraws = trackDraws;
  } else {
    levelDraws = geometry.levelDraws.map((draw) => ({
      ...draw,
      world: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      worldKind: 'baked-into-mesh'
    }));

    // The real River render geometry: committed level_inspect direct draws, drawn
    // at their source world positions. The collision surface is not a draw; it
    // travels in `physicsSurfaces` with visible:false as physics provenance.
    trackVisual = geometry.trackVisual;
    if (!trackVisual || trackVisual.label !== 'asset-reader-direct-draws' ||
        !Array.isArray(trackVisual.draws) || trackVisual.draws.length === 0) {
      throw new Error('geometry does not carry the v4 real track visual (asset-reader-direct-draws); ' +
        'rebuild it with `node probes/e1-drive/tools/build_geometry.mjs`');
    }
    trackMesh = geometry.meshes.find((mesh) => mesh.id === trackVisual.meshId);
    if (!trackMesh) throw new Error('geometry track visual names a missing mesh ' + trackVisual.meshId);
    collisionSurface = geometry.collisionSurface;
    if (!collisionSurface || collisionSurface.visible !== false || !collisionSurface.mesh) {
      throw new Error('geometry is missing the hidden physics collision surface; rebuild it with ' +
        '`node probes/e1-drive/tools/build_geometry.mjs`');
    }
    physicsSurfaces = [{
      id: collisionSurface.id,
      meshId: collisionSurface.meshId,
      visible: false,
      physicsOnly: true,
      vertexCount: collisionSurface.vertexCount,
      triangleCount: collisionSurface.triangleCount,
      bounds: collisionSurface.bounds,
      source: collisionSurface.source,
      reason: collisionSurface.reason,
      mesh: collisionSurface.mesh,
      draw: {
        ...collisionSurface.draw,
        world: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
      }
    }];
    trackDraws = trackVisual.draws.map((draw) => ({
      ...draw,
      world: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      worldKind: 'baked-into-mesh'
    }));
    staticDraws = levelDraws.concat(trackDraws);
  }

  const wheelByCorner = new Map(body.wheelGroups.map((group) => [group.corner, group]));
  for (const corner of WHEEL_CORNERS) {
    if (!wheelByCorner.has(corner)) throw new Error('geometry has no wheel group for ' + corner);
  }
  const carMeshId = body.meshId;
  if (!carMeshId) throw new Error('geometry body has no mesh id');

  // The decoded retail paint colour for this car. `materialsFor` is the
  // committed table; an unknown slug leaves the diagnostic albedo in place and
  // records the typed reason instead of guessing a colour.
  let paintColour = null;
  let paintSource = null;
  try {
    const material = materialsFor(body.slug);
    paintColour = material.baseColour.slice(0, 3);
    paintSource = material.source?.paintJob ?? 'probes/car-materials';
  } catch (error) {
    paintSource = 'unavailable: ' + (error.message ?? String(error));
  }

  // Draws keep their manifest ranges and gain the wheel node that moves them.
  // Wheel draws sit on their group's rest-pose translation so their static
  // (tick-0) world matrix is already correct before any update.
  const carDraws = body.carDraws.map((draw) => {
    const { localBounds, ...rest } = draw;
    const corner = typeof draw.renderPartId === 'string' && draw.renderPartId.startsWith('wheel.')
      ? draw.renderPartId.slice('wheel.'.length) : null;
    const world = corner ? multiplyMat4(reference, wheelByCorner.get(corner).matrixColumnMajor) : reference;
    // The retail paint lookup: a draw whose material is the runtime paint
    // lookup uses the decoded paint ramp colour instead of the diagnostic
    // albedo. Every other class keeps its committed diagnostic albedo.
    let albedo = draw.albedo;
    if (draw.textureBinding?.status === 'runtimePaintLookup' && paintColour) {
      albedo = [paintColour[0], paintColour[1], paintColour[2],
        Array.isArray(draw.albedo) ? (draw.albedo[3] ?? 0) : 0];
    }
    return {
      ...rest,
      albedo,
      world,
      worldKind: 'packet-transform',
      bounds: boundsUnderMatrix(localBounds, world)
    };
  });

  const carNodes = body.carNodes.map((node) => ({ ...node, drawIds: node.drawIds.slice() }));
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

  const meshes = (mapRender ? [trackMesh, body.mesh] : [geometry.meshes[0], trackMesh, body.mesh]).map((mesh) => ({
    id: mesh.id,
    storage: mesh.storage,
    vertexCount: mesh.vertexCount,
    indexCount: mesh.indexCount,
    positions: mesh.positions,
    indices: mesh.indices,
    uv: mesh.uv ?? null,
    positionsSha256: mesh.positionsSha256,
    indicesSha256: mesh.indicesSha256,
    coordinateSpace: mesh.coordinateSpace,
    source: mesh.source
  }));
  for (const mesh of meshes) {
    if (!mesh.uv) continue;
    if (mesh.uv.storage !== 'base64-float32le' || mesh.uv.components !== 2 ||
        mesh.uv.vertexCount !== mesh.vertexCount || typeof mesh.uv.data !== 'string') {
      throw new Error('mesh ' + mesh.id + ' has a UV stream that does not match its vertex count');
    }
  }
  if (!geometry.texturePack) {
    throw new Error('geometry does not carry a texture pack');
  }
  if (mapRender) {
    if (!Array.isArray(mapRender.textures) || mapRender.textures.length === 0) {
      throw new Error('map render package carries no textures');
    }
  } else {
    if (!Array.isArray(geometry.textures) || geometry.textures.length === 0 || !geometry.texturePack) {
      throw new Error('geometry does not carry the v5 static albedo textures; rebuild it with ' +
        '`node probes/e1-drive/tools/build_geometry.mjs`');
    }
    if (!Array.isArray(geometry.levelTextures) || geometry.levelTextures.length !== 4 ||
        !geometry.levelPropTexturePack) {
      throw new Error('geometry does not carry the P73b level-instance prop BC1 pack; rebuild it with ' +
        '`node probes/e1-drive/tools/build_geometry.mjs`');
    }
  }
  if (!Array.isArray(body.textures) || !body.texturePack || !body.mesh.uv) {
    throw new Error('geometry body ' + body.slug + ' does not carry its P52 albedo textures and UV0 stream; ' +
      'rebuild it with `node probes/e1-drive/tools/build_geometry.mjs`');
  }
  // The packet carries the static level/track pack plus the four level-prop BC1
  // images and only the driven car's own images, so the upload stays bounded by
  // one car instead of the roster. In map mode the map's own texture pack replaces
  // the River track/level-prop packs.
  const packetTextures = (mapRender ? mapRender.textures : geometry.textures.concat(geometry.levelTextures))
    .concat(body.textures);
  const textureIds = new Set(packetTextures.map((texture) => texture.id));
  if (textureIds.size !== packetTextures.length) {
    throw new Error('the packet texture set contains duplicate ids');
  }
  for (const draw of trackDraws) {
    if (draw.textureId !== null && !textureIds.has(draw.textureId)) {
      throw new Error('track draw ' + draw.id + ' names unknown texture ' + draw.textureId);
    }
  }
  if (levelDraws.some((draw) => draw.textureId != null) && !geometry.meshes[0]?.uv) {
    throw new Error('the level-prop draws bind textures but the level mesh has no UV0 stream');
  }
  for (const draw of levelDraws) {
    if (draw.textureId != null && !textureIds.has(draw.textureId)) {
      throw new Error('level prop draw ' + draw.id + ' names unknown texture ' + draw.textureId);
    }
    if (draw.textureId != null && !draw.textureBinding?.uvHash) {
      throw new Error('level prop draw ' + draw.id + ' binds a texture without a recorded UV0 hash');
    }
  }
  for (const draw of carDraws) {
    if (draw.textureId != null && !textureIds.has(draw.textureId)) {
      throw new Error('car draw ' + draw.id + ' names unknown texture ' + draw.textureId);
    }
    if (draw.textureId != null && (draw.uvFlipU !== true || draw.uvFlipV === true)) {
      throw new Error('car draw ' + draw.id +
        ' binds a texture without the declared (1-u, v) sampling');
    }
  }
  for (const draw of trackDraws) {
    if (draw.uvFlipU === true || draw.uvFlipV === true) {
      throw new Error('track draw ' + draw.id + ' would be sampled with the car UV convention');
    }
  }

  const vertexTotal = meshes.reduce((sum, mesh) => sum + mesh.vertexCount, 0);
  const triangleTotal = meshes.reduce((sum, mesh) => sum + mesh.indexCount / 3, 0);

  // The car identity the engine actually decoded, plus the real body mesh this
  // packet draws for it. Optional, so a caller that does not pass it produces the
  // default car's packet.
  const car = options.car
    ? {
        name: options.car.name,
        slug: options.car.slug ?? null,
        recordIndex: options.car.recordIndex ?? null,
        recordId: options.car.recordId ?? null,
        drivetrain: options.car.drivetrain ?? null,
        mass: options.car.mass ?? null,
        fieldsSha256: options.car.fieldsSha256 ?? null,
        bodyMesh: body.meshId,
        bodyMeshReason: body.manifest.fallback
          ? 'FALLBACK: this roster car has no unambiguous model mapping (' +
            body.manifest.fallbackReason + '); the committed Corvette C3 body is drawn and labelled. ' +
            'Physics is the RP_CarDynamics record named above'
          : 'real per-car body/wheel mesh from ' + body.manifest.sourceModelPakPath + ' (model SHA-256 ' +
            body.manifest.sourceModelSha256 + '); the manifest is pinned by SHA-256 and its draw ranges are ' +
            're-verified against the mesh. Physics is the RP_CarDynamics record named above',
        bodyFallback: body.manifest.fallback === true,
        bodyManifest: body.manifest.path,
        bodyManifestSha256: body.manifest.sha256,
        bodyVertexCount: body.mesh.vertexCount,
        bodyDrawCount: body.carDraws.length,
        bodyPartCount: body.carParts.length,
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
          tool: 'probes/car-parts/tools/build_manifest.py',
          source: body.manifest.path,
          sourceSha256: body.manifest.sha256,
          note: 'part ids, draw ranges, wheel groups and rest-pose translations copied from the selected car\'s ' +
            'own committed part manifest'
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
    carPaint: {
      colour: paintColour,
      source: paintSource,
      paintDraws: carDraws.filter((draw) => draw.textureBinding?.status === 'runtimePaintLookup').length
    },
    textures: packetTextures,
    texturePack: geometry.texturePack,
    lightmaps: Array.isArray(geometry.lightmaps) ? geometry.lightmaps : [],
    carTexturePack: body.texturePack,
    draws: staticDraws.concat(carDraws),
    physicsSurfaces,
    placedObjects: [{
      meshId: body.meshId,
      placement: 'engine-spawn-transform',
      world: reference,
      reason:
        'tick 0 is the pose the engine reports after its 180-tick settle at the ground-probed ' +
        'spawn point; the translation and the three body axes come from the simulation, not from a chosen anchor'
    }],
    nodes: carNodes,
    updates: [],
    diagnostics: {
      drawCount: staticDraws.length + carDraws.length,
      meshCount: meshes.length,
      vertexTotal,
      triangleTotal,
      instancesEmitted: geometry.levelInstances?.emitted ?? levelDraws.length,
      instancesOmitted: geometry.levelInstances?.omitted ?? 0,
      culled: 0,
      materialsApplied: false,
      lighting: 'diagnostic-directional',
      scope:
        'River block27/node253 supported instances plus the real River track visual (' +
        trackDraws.length + ' level_inspect direct draws, ' + trackVisual.triangleCount +
        ' triangles) and the ' + body.name + ' body drawn as ' +
        body.carParts.length + ' manifest parts / ' + body.carDraws.length + ' draws (' +
        carDraws.filter((draw) => draw.textureId != null).length + ' sampling their P52 static albedo image) ' +
        'with four spinning wheel groups; the collision mesh stays in the packet as hidden physics provenance; ' +
        'materials and lighting remain diagnostic',
      sequence: {
        tickCount: 0,
        tickHz: TICK_HZ,
        motion: 'physics',
        motionReason:
          'each tick is one C_Scene::Simulate(1/60) of the real RacingPhysics vehicle on the River collision mesh ' +
          '(usa_la_river/Level.levelphysics); no parametric path, no keyframes, no synthetic motion',
        alphaSource: 'per-tick alpha is 0 (tick-exact); the consumer supplies its own fixed-step alpha',
        nodeIds: carNodes.map((node) => node.id),
        staticDrawCount: staticDraws.length,
        movedDrawCount: carDraws.length,
        firstTickHash: null,
        lastTickHash: null
      },
      extras: {
        drive: {
          simulation: 'wasm32 RacingPhysics + Gravity (T-005d 186-object closure)',
          stepSeconds: 1 / TICK_HZ,
          spawn: options.spawn ?? null,
          script: options.script ??
            '2 s throttle, 2 s coast, 1 s brake (probes/e1-drive/web/drive-script.js)',
          camera: 'chase orbit behind the car, yaw follows with a fixed per-tick lag, ' +
            'eye pulled in front of the first visible-geometry hit',
          stateFields: ['position', 'axisX', 'axisY', 'axisZ', 'speed', 'contacts', 'wheels'],
          ...(car ? { car } : {})
        },
        camera: {
          mode: 'orbit-chase',
          target: 'chassis position + lookHeight (1.0 m)',
          yaw: 'follows the car with a fixed per-tick lag (smoothing 0.18)',
          defaultDistanceMetres: 9.0,
          defaultHeightMetres: 2.4,
          orbitDistanceMetres: camera.orbitDistance,
          occlusion: {
            enabled: camera.occlusion,
            query: 'segment from the aim point to the desired eye, first hit against the visible static triangles',
            occluder: occluder.describe(),
            hiddenPhysicsSurfacesUsed: false,
            hiddenPhysicsSurfacesReason:
              'packet.physicsSurfaces carries visible:false collision geometry that the consumer neither uploads ' +
              'nor draws; pulling the camera in for an undrawn surface would produce a close-up with no visible ' +
              'cause, so only the drawn level props and the real track visual occlude',
            marginMetres: camera.occlusionMargin,
            minimumDistanceMetres: camera.occlusionMinimum,
            recoveryPerTick: camera.occlusionRecovery,
            nearFieldMetres: camera.occlusionNearField,
            nearFieldReason:
              'a hit closer than nearFieldMetres is inside the car\'s own rear envelope: the car is passing through ' +
              'the prop, so moving the eye in front of that hit would put it inside the car. The current distance is ' +
              'held and `nearField:true` is recorded instead of claiming a resolved occlusion',
            smoothing:
              'pull-in is immediate so the eye is never left behind a resolvable hit; push-out eases by ' +
              'recoveryPerTick (0.08 of the gap per 1/60 s tick) so leaving a prop does not pop',
            perTickRecord:
              'updates[].camera.occlusion { requestedDistance, distance, blocked, nearField, hitDistance, hitMesh }'
          }
        },
        parts: {
          manifest: body.manifest,
          partCount: body.carParts.length,
          drawCount: carDraws.length,
          nodeCount: carNodes.length,
          nodes: carNodes.map((node) => ({ id: node.id, drawCount: node.drawIds.length })),
          bodyDrawCount: carDraws.filter((draw) => draw.nodeId === CAR_NODE_ID).length,
          wheelDrawCount: carDraws.filter((draw) => draw.nodeId !== CAR_NODE_ID).length,
          texturedDrawCount: carDraws.filter((draw) => draw.textureId != null).length,
          textures: body.textures.length,
          textureBytes: body.textures.reduce((sum, texture) => sum + texture.rgbaBytes, 0),
          uvVertices: body.mesh.uv.vertexCount,
          uvBytes: body.mesh.uv.bytes,
          uvConvention: body.texturePack.uvConvention.sampleUV,
          drawClasses: body.texturePack.coverage,
          materialScope: body.texturePack.materialScope,
          colours:
            'diagnostic per-part colours for visual debugging only (materialsApplied:false); a draw with a ' +
            'bound P52 static albedo image samples that image with the mesh UV0 stream and does not use the colour',
        },
        levelProps: {
          meshId: geometry.meshes[0]?.id ?? null,
          drawCount: levelDraws.length,
          texturedDrawCount: levelDraws.filter((draw) => draw.textureId != null).length,
          diagnosticDrawCount: levelDraws.filter((draw) => draw.textureId == null).length,
          texturedTriangles: levelDraws.filter((draw) => draw.textureId != null)
            .reduce((sum, draw) => sum + draw.indexCount / 3, 0),
          diagnosticTriangles: levelDraws.filter((draw) => draw.textureId == null)
            .reduce((sum, draw) => sum + draw.indexCount / 3, 0),
          blockedInstances: levelDraws.filter((draw) => draw.textureId == null)
            .map((draw) => draw.source.instanceIndex),
          blockedReason: 'bc3-alpha-rule-missing',
          manifest: geometry.levelPropTexturePack?.manifest ?? null,
          manifestSha256: geometry.levelPropTexturePack?.manifestSha256 ?? null,
          contentHash: geometry.levelPropTexturePack?.contentHash ?? null,
          textures: geometry.levelTextures.length,
          textureBytes: geometry.levelTextures.reduce((sum, texture) => sum + texture.rgbaBytes, 0),
          uvVertices: geometry.meshes[0]?.uv?.vertexCount ?? 0,
          uvValues: geometry.meshes[0]?.uv?.values ?? 0,
          uvBytes: geometry.meshes[0]?.uv?.bytes ?? 0,
          uvSha256: geometry.meshes[0]?.uv?.sha256 ?? null,
          sampler: geometry.levelPropTexturePack?.sampler ?? null,
          reason:
            'P73a exported the real instance UV0 and the static g_tAlbedo identity; 18 of 22 draws ' +
            'sample a decoded BC1 image with that UV0 stream while the 4 BC3-alpha cab draws keep a ' +
            'labelled neutral diagnostic albedo because no alpha rule is declared. Material colour, ' +
            'blend state, shader stages, mip chain and sRGB are not applied',
        },
        textures: {
          levelAndTrack: {
            count: geometry.textures.length + geometry.levelTextures.length,
            rgbaBytes: geometry.textures.reduce((sum, texture) => sum + texture.rgbaBytes, 0) +
              geometry.levelTextures.reduce((sum, texture) => sum + texture.rgbaBytes, 0),
          },
          car: {
            count: body.textures.length,
            rgbaBytes: body.textures.reduce((sum, texture) => sum + texture.rgbaBytes, 0),
            manifest: body.texturePack.manifest,
            manifestSha256: body.texturePack.manifestSha256,
            p52Manifest: body.texturePack.p52Manifest,
            sceneReport: body.texturePack.sceneReport,
            sampler: body.texturePack.sampler,
            scopeLabels: body.texturePack.scopeLabels,
            drawClasses: body.texturePack.coverage,
          },
          uploaded: {
            count: packetTextures.length,
            rgbaBytes: packetTextures.reduce((sum, texture) => sum + texture.rgbaBytes, 0),
          },
          reason:
            'the packet carries the static track albedo pack, the four level-instance BC1 images and only ' +
            'the driven car\'s own P52 static images; 18 of 22 level prop draws and 224 of 491 car draws ' +
            'sample a static image, while the 4 BC3-alpha cab draws and the 267 runtime-only car draws ' +
            '(45 paint lookup, 66 light off/on blend, 156 _NO_ALBEDO) keep the diagnostic albedo and the ' +
            'committed reason. No mip chain, sRGB, material colour or blend state is applied',
        },
        wheels: {
          rendered: WHEELS_RENDERED,
          wheelGroupCount: body.wheelGroups.length,
          wheelNodes: carNodes.filter((node) => node.id !== CAR_NODE_ID).map((node) => node.id),
          spinAxis: 'element-local +X',
          spinAxisSource: 'wheel/rim local bounds are thin on X; VehicleActor.cpp:5158-5197 spins about wheelMatrix.AX()',
          spinMembers: body.wheelGroups[0]?.spinMembers ?? ['tyre', 'rim', 'brakeDisc'],
          staticMembers: body.wheelGroups[0]?.staticMembers ?? ['brakeCaliper'],
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
            'the committed scene reader returns one car mesh per model; the selected car\'s manifest proves which ' +
            'draws are tyre/rim/disc/caliper and where each wheel group sits'
        },
        surfaces: {
          surfaceMappingsApplied: false,
          reason: 'RP_SurfaceMappingList is not installed; engine grip/rolling/MI scales are the documented neutral values'
        },
        track: {
          id: trackVisual.meshId,
          trackVisual: trackVisual.label,
          drawCount: trackDraws.length,
          texturedDrawCount: trackDraws.filter((draw) => draw.textureId !== null).length,
          vertexCount: trackMesh.vertexCount,
          triangleCount: trackMesh.indexCount / 3,
          bounds: trackVisual.bounds,
          uv: {
            storage: trackMesh.uv.storage,
            components: trackMesh.uv.components,
            values: trackMesh.uv.values,
            bytes: trackMesh.uv.bytes,
            sha256: trackMesh.uv.sha256,
            source: trackMesh.uv.source.provenance
          },
          textures: {
            count: geometry.textures.length,
            rgbaBytes: geometry.textures.reduce((sum, texture) => sum + texture.rgbaBytes, 0),
            sampler: geometry.texturePack.sampler,
            coverage: geometry.texturePack.coverage
          },
          sections: trackVisual.sections.map((section) => ({
            key: section.key,
            geometryBlock: section.geometryBlock,
            nodeBlock: section.nodeBlock,
            drawCount: section.drawCount,
            vertexCount: section.vertexCount,
            triangleCount: section.triangleCount,
            driveBoxOverlap: section.driveBoxOverlap,
            reference: section.reference,
            referenceSha256: section.referenceSha256
          })),
          reason:
            'real River levelrender direct draws from the committed level_inspect references are drawn ' +
            'instead of the diagnostic collision slab; every draw keeps its source index range, the real UV0 ' +
            'stream and, where P44/P45/P47 measured one, its static g_tAlbedo texture; material colour, blend ' +
            'state, shader stages, mip chain and sRGB interpretation remain unapplied (materialsApplied:false)',
          coverage: collisionSurface.coverage ?? null
        },
        collisionSurface: {
          id: collisionSurface.id,
          visible: false,
          physicsOnly: true,
          vertexCount: collisionSurface.vertexCount,
          triangleCount: collisionSurface.triangleCount,
          bounds: collisionSurface.bounds,
          source: collisionSurface.source,
          reason:
            'the simulated wheels trace usa_la_river/Level.levelphysics through the wasm physics; this ' +
            'collision mesh is kept in packet.physicsSurfaces for provenance and is not in packet.meshes, ' +
            'so it is neither uploaded nor drawn'
        },
        carBodyShape: 'box-from-XT-geometry',
        carBodyShapeReason: 'retail builds the gravity body from the model import; this slice uses the T-005d box proxy',
        meshFrame:
          'the car mesh is drawn in the engine body frame; the retail mesh-to-body alignment is not recovered ' +
          '(the model import is out of scope), so the body may be rotated/offset relative to the chassis'
      },
      approximations: [
        'level and vehicle materials are not applied; car draws with a P52 static albedo image sample that image, every other car draw uses a diagnostic per-part colour, and all non-car draws use a neutral albedo, under one directional light',
        'the real track visual keeps every source draw index range and samples the static g_tAlbedo texture with the real UV0 stream on 297 of 394 draws; the 2 runtime-only albedo draws and the 95 block88/node283 draws with no P45/P47 binding row keep the diagnostic albedo',
        'the car body samples the P52 static g_MeshTexture image with the car mesh UV0 stream on 224 of 491 draws; the 267 runtime-only draws (45 paint lookup, 66 light off/on blend, 156 _NO_ALBEDO) keep the diagnostic albedo and the committed P52 reason',
        'texture sampling is rgba8unorm mip0 with repeat/linear: no sRGB-to-linear conversion, mip chain, anisotropy or material colour is applied, so it is not retail sampling fidelity',
        'no shadow, post-process, particle or effect pass exists in this consumer',
        'face normals come from screen-space derivatives of the world position, not from original vertex normals',
        'the car mesh is aligned to the engine body frame directly; the retail mesh import and its offset are not recovered',
        'wheel placement uses the manifest rest-pose translation; the spin angle is integrated from the physics wheel angular velocity, not read as an angle',
        'the tyre/rim/disc spin marker is a diagnostic band, not a material or a texture',
        'grip, rolling friction and MI scales are the engine neutral values because no surface mapping list is installed'
      ],
      notRecovered: [
        'level material list to shader binding',
        'retail texture sampler state (wrap mode, filter, anisotropy, mip selection, sRGB interpretation)',
        'original level and vehicle lighting rigs',
        'vehicle paint lookup texture and runtime light blends',
        'vehicle material colour, blend state and shader stages (only the P52 decoded albedo pixels are bound)',
        'runtime per-wheel matrices (suspension, steer, camber), higher LODs and damage states',
        'engine asset streaming, culling and draw-list production (this slice drives one car on one loaded block)',
        'level blocks 26, 32 and 31 instances'
      ],
      limits: [
        car
          ? 'one car at a time, selected from the RP_CarDynamics roster at runtime: not a race, a game loop or a full level'
          : 'one car, one loaded River track visual, one camera: not a race, a game loop or a full level',
        'no audio, no HUD beyond diagnostics, no multiplayer, no race rules',
        'the car body is the selected roster car\'s own real mesh; 224 of its 491 draws sample their P52 ' +
          'static albedo image, the 267 runtime-only draws keep a diagnostic colour, and paint, light blend, ' +
          'material colour, blend state, mips and sRGB are not decoded',
        'packet v1.1 is JSON with inline geometry; it is not an engine draw-list integration',
        'the real track visual covers the committed direct-draw sections only (block88/node283 and block56/node289); ' +
          'block88/node283 lies outside the drive box, and block56/node289 ends around x = -55, so the last ~12 m of ' +
          'the script and the off-road area have no committed real draw geometry and no ground is drawn there',
        'the collision surface is retained as hidden physics provenance (packet.physicsSurfaces, visible:false) and ' +
          'is never drawn; the wheels still trace the whole Level.levelphysics mesh',
        'the chase camera resolves occlusion with one target->eye segment cast per packet tick against the visible ' +
          'static geometry (level props + real track visual); it is not continuous collision detection, it does not ' +
          'sweep between ticks, and hidden physics geometry is not an occluder',
        'the consumer\'s manual drag/zoom camera is a debug view and is not occlusion-checked; the packet chase ' +
          'camera and the ?camdist/camheight/camyaw overrides are resolved the same way',
        'native-vs-wasm numeric parity is blocked by the DirectX SDK (T-007-vehicle-physics.md §7)'
      ]
    }
  };

  // Map package (M3) provenance replaces the River-specific scope text. Every
  // value below is read from the map package; nothing is inferred.
  if (mapRender) {
    const mapCounts = geometry.map?.counts ?? null;
    const mapLevel = geometry.map?.level ?? 'map';
    const mapPackage = geometry.map?.packageLabel ?? 'map-render';
    const blockedDecal = mapRender.blocked?.effectDecal?.draws ?? 0;
    const blockedDiagnostic = mapRender.blocked?.diagnosticOnly?.draws ?? 0;
    packet.diagnostics.scope =
      mapLevel + ' first-RenderList direct LOD0 draws: ' + mapRender.drawCount + ' opaque draws / ' +
      (mapRender.triangleTotal ?? 0) + ' triangles across ' + mapRender.texturePack.uniqueBlobs +
      ' uploaded textures, plus the ' + body.name + ' body drawn as ' + body.carParts.length +
      ' manifest parts / ' + body.carDraws.length + ' draws; the ' + mapRender.blocked.draws +
      ' blocked draws (' + blockedDecal + ' effect/decal, ' + blockedDiagnostic + ' diagnostic) are skipped with labels; no vertex normals are present, ' +
      'so shading uses the consumer screen-space derivative normals; materials/blend/sampler state remain diagnostic';
    packet.diagnostics.extras.map = {
      level: mapLevel,
      package: mapPackage,
      label: mapRender.label,
      source: mapRender.source ?? null,
      counts: mapCounts,
      drawCount: mapRender.drawCount,
      triangleCount: mapRender.triangleTotal,
      texturedDrawCount: mapRender.texturedDrawCount,
      vertexCount: mapRender.vertexCount,
      textures: {
        count: mapRender.texturePack.uniqueBlobs,
        bytesMip0: mapRender.texturePack.bytesMip0,
        format: mapRender.texturePack.format,
        srgbVariant: mapRender.texturePack.srgbVariant,
        srgbAppliedByProducer: mapRender.texturePack.srgbAppliedByProducer,
        mipPolicy: mapRender.texturePack.mipPolicy
      },
      blocked: mapRender.blocked,
      normals: mapRender.normals,
      instances: mapRender.instances,
      unsupportedSections: mapRender.unsupportedSections,
      collisionSurface: {
        visible: false,
        physicsOnly: true,
        vertexCount: mapRender.collisionSurface.vertexCount,
        triangleCount: mapRender.collisionSurface.triangleCount,
        source: mapRender.collisionSurface.source
      },
      limits: mapRender.limits
    };
    packet.diagnostics.extras.track = {
      id: mapRender.meshId,
      trackVisual: mapRender.label,
      drawCount: mapRender.drawCount,
      texturedDrawCount: mapRender.drawCount,
      vertexCount: mapRender.vertexCount,
      triangleCount: mapRender.triangleTotal,
      bounds: mapRender.bounds,
      uv: {
        storage: trackMesh.uv.storage,
        components: trackMesh.uv.components,
        values: trackMesh.uv.values,
        bytes: trackMesh.uv.bytes,
        sha256: trackMesh.uv.sha256,
        source: trackMesh.uv.source.provenance
      },
      textures: {
        count: mapRender.texturePack.uniqueBlobs,
        rgbaBytes: mapRender.texturePack.bytesMip0,
        sampler: mapRender.texturePack.sampler,
        coverage: null
      },
      sections: [],
      reason: mapLevel + ' first-RenderList direct LOD0 draws from the committed map-slice render package; ' +
        'every opaque draw carries its source index range, real UV0 and resolved static albedo identity',
      coverage: null
    };
    packet.diagnostics.extras.textures.levelAndTrack = {
      count: mapRender.texturePack.uniqueBlobs,
      rgbaBytes: mapRender.texturePack.bytesMip0,
      source: mapLevel + ' map-slice render package'
    };
    packet.diagnostics.extras.textures.reason =
      'the packet carries the ' + mapLevel + ' ' + mapRender.texturePack.uniqueBlobs +
      ' merged RGBA8 mip0 albedo blobs plus only the driven car\'s ' +
      'own P52 images; the producer records sRGB/mip generation as hints and the consumer applies its ' +
      'documented sRGB + derived mip policy. Material colour, blend state and sampler wrap/filter are not applied';
    packet.diagnostics.extras.textures.uploaded = {
      count: packetTextures.length,
      rgbaBytes: packetTextures.reduce((sum, texture) => sum + texture.rgbaBytes, 0)
    };
    packet.diagnostics.extras.collisionSurface = {
      id: mapRender.collisionSurface.id,
      visible: false,
      physicsOnly: true,
      vertexCount: mapRender.collisionSurface.vertexCount,
      triangleCount: mapRender.collisionSurface.triangleCount,
      bounds: mapRender.collisionSurface.bounds,
      source: mapRender.collisionSurface.source,
      reason: 'the simulated wheels trace ' + mapLevel + '/Level.levelphysics through the wasm physics; this ' +
        'collision mesh is kept in packet.physicsSurfaces for provenance and is not in packet.meshes, ' +
        'so it is neither uploaded nor drawn'
    };
    packet.diagnostics.extras.levelProps = {
      meshId: mapRender.meshId,
      drawCount: 0,
      texturedDrawCount: 0,
      diagnosticDrawCount: 0,
      texturedTriangles: 0,
      diagnosticTriangles: 0,
      blockedInstances: [],
      blockedReason: 'none: the ' + mapLevel + ' package has no River level-prop layer',
      manifest: null,
      manifestSha256: null,
      contentHash: null,
      textures: 0,
      textureBytes: 0,
      uvVertices: 0,
      uvValues: 0,
      uvBytes: 0,
      uvSha256: null,
      sampler: null,
      reason: 'the map package replaces the River level-prop/track packs'
    };
    packet.diagnostics.approximations = [
      mapLevel + ' direct draws sample their static g_tAlbedo image with the real UV0 stream and the consumer sRGB/mip policy; material colour, blend state and sampler wrap/filter remain unapplied',
      'no vertex normals were decoded; shading uses screen-space derivatives of the world position (the existing consumer path)',
      'the ' + blockedDecal + ' effect/decal draws and ' + blockedDiagnostic + ' diagnostic draws are skipped with labels: no fallback texture or colour is invented',
      'the ' + mapRender.unsupportedSections + ' unsupported sections and ' + mapRender.instances.descriptions + ' instance descriptions are not applied and can add surfaces',
      'one directional light; no shadow, post-process, particle or effect pass exists in this consumer',
      'wheel placement uses the manifest rest-pose translation; the spin angle is integrated from the physics wheel angular velocity'
    ];
    packet.diagnostics.limits = [
      mapLevel + ' first-RenderList direct LOD0 draws only: ' + mapRender.unsupportedSections +
        ' unsupported sections and ' + mapRender.instances.descriptions + ' instance descriptions are not applied',
      'the path is measured, not a retail start line; this is one point-to-point sprint, not a lap',
      'collision triangles exclude the simple shapes and InstancedTriangleMesh; the engine still loads the complete Level.levelphysics',
      'no ' + (geometry.map?.label ?? 'map') + ' prop colliders, power-ups, opponents, AI or race audio',
      'one car at a time; the car body uses the selected roster car\'s own mesh'
    ];
  }


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
