// Additive visible-prop collision layer for the E1 drive modes.
//
// The layer consumes a P74 V2 manifest and the read-only resolver
// `probes/prop-collision/lib/resolver.mjs` through an injected `world`
// (createWorld(manifest, { profile })). It runs *after* the engine tick and never
// writes a physics value: the engine's state, input and tick clock stay
// authoritative. Only the pose handed to the render packet, the rules observer
// and the camera is the resolved pose.
//
// Why a post-tick pose layer is enough to stop the car from passing a prop: the
// resolver is advanced from its own previous pose by the engine's measured XZ
// delta, with 8 cm substeps. A blocked car therefore stays on the near face even
// when the engine (which does not know about visible props) keeps pushing; a
// thin collider cannot be tunnelled at 31 m/s because each substep is resolved.
// When the car backs away or drives around, the layer follows the same deltas.
//
// Nothing here is a retail collision solver and nothing claims recovered
// materials, prop physics or car-to-car collision.

export const PROP_PROFILE = 'all-visible';
export const PROP_PROFILE_ROADSIDE = 'roadside';

// P74 V2 base manifest: the 310 m band (30 m), the free box and the loop-01
// corridor (8 m). `roadside` = 553 colliders (98 on-measured-course components
// stay mapped but inactive); `all-visible` = 651 colliders.
export const PROP_MANIFEST = '_work/prop-collision/colliders-v2.json';
export const PROP_MANIFEST_FILE_SHA256 =
  'sha256:3348875297fdb79699410069548c724840761c61b3386e3d5bbb5974448751d7';
export const PROP_MANIFEST_CONTENT_SHA256 =
  'sha256:736207391f8efc0457a652c126c7d3beaa51e3a4ca55619be84f2f02be4db9ee';
export const PROP_MANIFEST_VARIANT = 'playable-regions-v2';
export const PROP_RESOLVER =
  'probes/prop-collision/lib/resolver.mjs (read-only; createWorld/deepestContact/step)';

/**
 * A manifest/profile/pin mismatch is a typed, fatal error. It is never a reason
 * to fall back to another manifest or another profile.
 */
export class PropManifestError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PropManifestError';
    this.code = code;
  }
}

/**
 * Measured driven-line exclusions for the timed 310 m sprint (P74b).
 *
 * The V2 `roadside` profile is clear on the measured centreline (0/1,245), but
 * the committed five-car scripted sprint follows the Stanley line with up to
 * ~0.6-0.9 m lateral error and grazes nine active colliders (fence posts and
 * rack components at the edge of the four known arcs). Making those solid would
 * change every affected car's inputs, state hash and finish time, i.e. break the
 * committed sprint. They are therefore excluded for the timed course only, by
 * exactly the measured set, and every other V2 structure stays solid.
 *
 * The list is derived from the committed reference ghost traces by
 * `tools/derive_sprint_exclusions.mjs` and re-checked by the verifier. It is not
 * typed in and the manifest is not modified.
 */
export const SPRINT_DRIVEN_EXCLUSIONS = Object.freeze([
  'river.block56.node289.draw.115.component.015',
  'river.block56.node289.draw.116.component.043',
  'river.block56.node289.draw.116.component.044',
  'river.block56.node289.draw.116.component.047',
  'river.block56.node289.draw.97.component.063',
  'river.block56.node289.draw.99.component.029',
  'river.block56.node289.draw.99.component.042',
  'river.block56.node289.draw.99.component.043',
  'river.block56.node289.draw.99.component.047'
]);
export const SPRINT_DRIVEN_EXCLUSION_CONTENT_SHA256 =
  'sha256:9603f8580fc3ed2dd89a6571529b54d4cb6a81394724e6462d9c50192986b4f2';
export const SPRINT_DRIVEN_EXCLUSION_ARTIFACT = '_work/e1-drive/sprint-driven-exclusions.json';

/** Mark the measured driven-line colliders inactive for the timed course only. */
export function applyDrivenLineExclusions(manifest, ids = SPRINT_DRIVEN_EXCLUSIONS) {
  const excluded = new Set(ids);
  return {
    ...manifest,
    colliders: manifest.colliders.map((collider) =>
      excluded.has(collider.id) ? { ...collider, active: false } : collider)
  };
}

/**
 * Manifest/profile/hash pins are parameters, not module constants: the same
 * page binds three different modes. A world whose profile or collider count
 * disagrees with the pins is a hard failure, never a silently different layer.
 */
export const SPRINT_PROP_PINS = Object.freeze({
  label: '310m',
  profile: PROP_PROFILE_ROADSIDE,
  manifest: PROP_MANIFEST,
  manifestFileSha256: PROP_MANIFEST_FILE_SHA256,
  manifestContentSha256: PROP_MANIFEST_CONTENT_SHA256,
  variant: PROP_MANIFEST_VARIANT,
  manifestColliders: 651,
  // P74 roadside profile = 553; 9 measured driven-line colliders are excluded
  // for the timed course only, leaving 544 active colliders.
  profileColliders: 553,
  colliders: 544,
  drivenLineExclusions: SPRINT_DRIVEN_EXCLUSIONS.length,
  drivenLineExclusionContentSha256: SPRINT_DRIVEN_EXCLUSION_CONTENT_SHA256,
  resolver: PROP_RESOLVER
});

export const LAP_PROP_PINS = Object.freeze({
  label: 'lap',
  profile: PROP_PROFILE,
  manifest: PROP_MANIFEST,
  manifestFileSha256: PROP_MANIFEST_FILE_SHA256,
  manifestContentSha256: PROP_MANIFEST_CONTENT_SHA256,
  variant: PROP_MANIFEST_VARIANT,
  manifestColliders: 651,
  profileColliders: 651,
  colliders: 651,
  resolver: PROP_RESOLVER
});

/** P74 R04-V2 manifest (region: reachable free-roam component + 30 m ring). */
export const FREE_PROP_PINS = Object.freeze({
  label: 'free-roam',
  profile: PROP_PROFILE,
  manifest: '_work/free-roam-prop/colliders-r04-v2.json',
  manifestFileSha256: 'sha256:b1b8f2c9c833f452c1df98f870b281349a6a29a9db2492462190ccf39fd18211',
  manifestContentSha256: 'sha256:663e2570d1949e9bde155ec872e9fccfc09117833b5d3a663a275e686ef20b38',
  variant: 'free-roam-r04',
  manifestColliders: 447,
  profileColliders: 447,
  colliders: 447,
  resolver: PROP_RESOLVER
});

/**
 * The prop layer a course binds. `?course=310` is the timed sprint (roadside:
 * the four measured on-course arcs must stay excluded), `?course=lap` is the
 * three-lap loop (all-visible: the loop is clear and the 56 formerly missing lap
 * components are solid) and `?course=free` is free roam (R04-V2 all-visible).
 * `?course=short` is the untouched 29 m regression course and binds no layer.
 */
export function propPinsForCourse(courseId) {
  if (courseId === 'free') return FREE_PROP_PINS;
  if (courseId === 'lap') return LAP_PROP_PINS;
  if (courseId === '310' || courseId === '310m') return SPRINT_PROP_PINS;
  return null;
}

/**
 * Capture-only collision probes. The target ids, approach axis and approach
 * distance are read from the manifest at run time; nothing is typed in. The
 * head-on verification uses the same records (31 m/s kinematic drive) and these
 * definitions give the browser capture a deterministic start pose.
 */
export const COLLISION_PROBES = Object.freeze({
  'lap-sign': Object.freeze({
    // The 44 m building wall draw.355 sits on the upper terrace (its own ground
    // is 6.514 m) and is not reachable from the loop at ~3.2 m. The capture uses
    // the reachable loop-side no-parking sign; the resolver head-on still tests
    // draw.355 at its own measured ground.
    label: 'lap no-parking sign draw.257',
    course: 'lap',
    target: 'river.block71.node209.draw.257.component.000',
    axis: 2,
    sign: 1,
    distanceMetres: 6
  }),
  'free-pipe': Object.freeze({
    // A broad concrete-pipe section whose ground column overlaps the approach
    // (draw.95.component.004 is overhead on the lower approach side).
    label: 'free-roam concrete pipe draw.95',
    course: 'free',
    target: 'river.block56.node289.draw.95.component.010',
    axis: 2,
    sign: -1,
    distanceMetres: 12
  })
});

/**
 * Start pose of a capture-only collision probe: `distanceMetres` outside the
 * target's near face along `axis`, facing the target. `sign` selects the side
 * that is clear in the full manifest (the caller must still verify it).
 */
export function collisionProbePose(manifest, spec) {
  const collider = manifest?.colliders?.find((entry) => entry.id === spec.target);
  if (!collider) throw new PropManifestError('probe-target', 'collision probe target is not in the manifest: ' + spec.target);
  const axis = collider.axes[spec.axis];
  const length = Math.hypot(axis[0], axis[2]) || 1;
  const nx = (axis[0] / length) * (spec.sign ?? 1);
  const nz = (axis[2] / length) * (spec.sign ?? 1);
  return {
    target: spec.target,
    label: spec.label,
    x: collider.center[0] + nx * spec.distanceMetres,
    z: collider.center[2] + nz * spec.distanceMetres,
    headingRad: Math.atan2(-nx, -nz),
    outward: [nx, nz],
    nearFaceMetres: collider.half[spec.axis],
    targetCenter: [collider.center[0], collider.center[2]]
  };
}

/**
 * Validate a parsed manifest against a pin set. The caller has already hashed
 * the file bytes; this checks the declared identity and content hash so a
 * swapped or hand-edited manifest cannot masquerade as the pinned one.
 */
export function checkPropManifest(manifest, pins) {
  const errors = [];
  if (manifest?.kind !== 'prop-collision-colliders' || manifest?.version !== 1) {
    errors.push('manifest is not prop-collision-colliders v1');
  }
  if (pins.variant !== null && manifest?.variant !== pins.variant) {
    errors.push('manifest variant is ' + JSON.stringify(manifest?.variant) + ', expected ' + pins.variant);
  }
  const manifestColliders = pins.manifestColliders ?? pins.colliders;
  if (!Array.isArray(manifest?.colliders) || manifest.colliders.length !== manifestColliders) {
    errors.push('manifest has ' + (manifest?.colliders?.length ?? 'no') + ' colliders, expected ' + manifestColliders);
  }
  const contentHash = String(manifest?.contentSha256 ?? '').replace(/^sha256:/, '');
  const pinnedContentHash = String(pins.manifestContentSha256 ?? '').replace(/^sha256:/, '');
  if (contentHash !== pinnedContentHash) {
    errors.push('manifest content hash is ' + JSON.stringify(manifest?.contentSha256) +
      ', expected ' + pins.manifestContentSha256);
  }
  if (pins.variant !== null && manifest?.profiles?.[pins.profile]?.colliders !==
      (pins.profileColliders ?? pins.colliders)) {
    errors.push('manifest profile ' + pins.profile + ' does not declare ' +
      (pins.profileColliders ?? pins.colliders) + ' colliders');
  }
  return { ok: errors.length === 0, errors };
}

/** The resolver's length axis is (cos yaw, sin yaw); the engine forward is (sin h, cos h). */
export function propYawFromHeading(headingRad) {
  return Math.PI / 2 - headingRad;
}

/**
 * Wrap one resolver world as a per-tick pose layer.
 *
 * `world` is `createWorld(manifest, { profile: 'all-visible' })`. `pins` defaults
 * to the committed P66 lap layer; free roam passes `FREE_PROP_PINS`.
 * `carEnvelope` defaults to the manifest's documented 2.98 x 1.68 x 1.35 m
 * envelope.
 */
export function createPropLayer({ world, carEnvelope, dt = 1 / 60, pins = LAP_PROP_PINS }) {
  if (!world || typeof world.step !== 'function') {
    throw new PropManifestError('resolver-world', 'prop layer needs the committed resolver world');
  }
  if (!pins || typeof world.colliders?.length !== 'number') {
    throw new PropManifestError('pins-missing', 'prop layer needs its manifest pins');
  }
  if (world.profile !== pins.profile) {
    throw new PropManifestError('profile-mismatch',
      'prop layer world profile ' + world.profile + ' is not the pinned ' + pins.profile);
  }
  if (world.colliders.length !== pins.colliders) {
    throw new PropManifestError('collider-count-mismatch',
      'prop layer world has ' + world.colliders.length + ' colliders, pinned ' + pins.colliders +
      ' (' + pins.manifest + ')');
  }
  const envelope = carEnvelope ?? world.manifest?.carEnvelope ?? { length: 2.98, width: 1.68, height: 1.35 };
  let render = null;
  let previous = null;
  let blockedTicks = 0;
  let contactTicks = 0;
  let contacts = 0;
  let substeps = 0;
  let maxPenetration = 0;
  let lastContacts = [];

  function begin(state, groundY) {
    if (!state?.position) throw new Error('prop layer needs the tick-0 engine state');
    render = { x: state.position[0], z: state.position[2] };
    previous = { x: render.x, z: render.z };
    blockedTicks = 0;
    contactTicks = 0;
    contacts = 0;
    substeps = 0;
    maxPenetration = 0;
    lastContacts = [];
    void groundY;
  }

  /**
   * Consume one engine state and return the pose the render packet should use.
   * With no contact the returned object is the engine state itself, so the lap
   * (no props within 69.5 m of loop-01) is byte-for-byte unchanged.
   */
  function afterTick(state, groundY) {
    if (!render) begin(state, groundY);
    const px = state.position[0];
    const pz = state.position[2];
    const dx = px - previous.x;
    const dz = pz - previous.z;
    const heading = Math.atan2(state.axisZ[0], state.axisZ[2]);
    const yaw = propYawFromHeading(heading);
    // Substep the engine's measured delta at 8 cm and push the layer's pose out
    // of every overlapping collider. Positional resolve keeps the yaw the engine
    // reports, so a glancing hit slides instead of rotating into the face.
    const distance = Math.hypot(dx, dz);
    const steps = Math.max(1, Math.min(64, Math.ceil(distance / 0.08)));
    let tickContacts = [];
    let tickResidual = 0;
    for (let step = 0; step < steps; step++) {
      render.x += dx / steps;
      render.z += dz / steps;
      const resolved = world.resolvePose(render.x, render.z, yaw, groundY, envelope,
        { maxIterations: 12, slop: 0.001 });
      render = { x: resolved.x, z: resolved.z };
      for (const contact of resolved.contacts) {
        if (!tickContacts.includes(contact.colliderId)) tickContacts.push(contact.colliderId);
        if (contact.penetration > maxPenetration) maxPenetration = contact.penetration;
      }
      if (resolved.residual > tickResidual) tickResidual = resolved.residual;
    }
    substeps += steps;
    if (tickContacts.length) {
      blockedTicks++;
      contactTicks++;
      contacts += tickContacts.length;
      lastContacts = tickContacts.slice();
    }
    // Before the first contact the render pose is exactly the engine pose; after
    // a contact the layer keeps its own resolved pose and follows engine deltas.
    if (blockedTicks === 0) render = { x: px, z: pz };
    previous = { x: px, z: pz };
    if (blockedTicks === 0) return state;
    return {
      ...state,
      position: [render.x, state.position[1], render.z],
      props: {
        profile: pins.profile,
        blockedTicks,
        contactTicks,
        contacts,
        lastContacts: lastContacts.slice()
      }
    };
  }

  function snapshot() {
    return {
      label: pins.label,
      profile: pins.profile,
      manifest: pins.manifest,
      manifestFileSha256: pins.manifestFileSha256,
      manifestContentSha256: pins.manifestContentSha256,
      variant: pins.variant,
      resolver: pins.resolver,
      carEnvelope: { ...envelope },
      colliders: world.colliders.length,
      pinnedColliders: pins.colliders,
      manifestColliders: pins.manifestColliders ?? pins.colliders,
      profileColliders: pins.profileColliders ?? pins.colliders,
      drivenLineExclusions: pins.drivenLineExclusions ?? 0,
      drivenLineExclusionContentSha256: pins.drivenLineExclusionContentSha256 ?? null,
      blockedTicks,
      contactTicks,
      contacts,
      substeps,
      maxPenetrationMetres: maxPenetration,
      lastContacts: lastContacts.slice(),
      applied: true
    };
  }

  return { begin, afterTick, snapshot };
}
