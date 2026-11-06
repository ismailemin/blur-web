// Additive visible-prop collision layer for the E1 lap mode.
//
// The layer consumes the P66 manifest `_work/prop-collision/colliders.json` and
// the read-only resolver `probes/prop-collision/lib/resolver.mjs` through an
// injected `world` (createWorld(manifest, { profile })). It runs *after* the
// engine tick and never writes a physics value: the engine's state, input and
// tick clock stay authoritative. Only the pose handed to the render packet, the
// rules observer and the camera is the resolved pose.
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
export const PROP_MANIFEST = '_work/prop-collision/colliders.json';
export const PROP_MANIFEST_FILE_SHA256 =
  'sha256:a98fb8eb7e7a6f6851e0c6b5671d40be2c346d0c28a2442df0fe6ab497317af4';
export const PROP_MANIFEST_CONTENT_SHA256 =
  'sha256:8f09d12d2fcd6ea183a7bcdd6f72f53571f8b91f995cf898af1286a057ffd174';
export const PROP_RESOLVER =
  'probes/prop-collision/lib/resolver.mjs (read-only; createWorld/deepestContact/step)';

/** The resolver's length axis is (cos yaw, sin yaw); the engine forward is (sin h, cos h). */
export function propYawFromHeading(headingRad) {
  return Math.PI / 2 - headingRad;
}

/**
 * Wrap one resolver world as a per-tick pose layer.
 *
 * `world` is `createWorld(manifest, { profile: 'all-visible' })`. `carEnvelope`
 * defaults to the manifest's documented 2.98 x 1.68 x 1.35 m envelope.
 */
export function createPropLayer({ world, carEnvelope, dt = 1 / 60 }) {
  if (!world || typeof world.step !== 'function') throw new Error('prop layer needs the P66 resolver world');
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
        profile: PROP_PROFILE,
        blockedTicks,
        contactTicks,
        contacts,
        lastContacts: lastContacts.slice()
      }
    };
  }

  function snapshot() {
    return {
      profile: PROP_PROFILE,
      manifest: PROP_MANIFEST,
      manifestFileSha256: PROP_MANIFEST_FILE_SHA256,
      manifestContentSha256: PROP_MANIFEST_CONTENT_SHA256,
      resolver: PROP_RESOLVER,
      carEnvelope: { ...envelope },
      colliders: world.colliders.length,
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
