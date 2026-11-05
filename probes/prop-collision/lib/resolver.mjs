/*
 * resolver.mjs — standalone 2.5D car-OBB vs static-OBB resolver prototype.
 *
 * The car is a 2.98 x 1.68 m rectangle (documented maximum XT envelope) on the
 * ground plane, with a 1.35 m vertical body used only for the overlap filter.
 * Every static collider is an oriented box; its XZ axes are axes[0]/axes[2] and
 * its vertical span is center[1] ± half[1].
 *
 * The step is deterministic:
 *   - fixed 1/60 s caller step;
 *   - substeps are sized from the actual speed (max 8 cm of travel per substep),
 *     so 31 m/s cannot tunnel through even a thin collider;
 *   - each substep resolves the deepest contact first, for a fixed maximum
 *     number of iterations;
 *   - contact axis ties are broken by a fixed axis order.
 *
 * It is a prototype for the PoC, not a retail vehicle collision solver.
 */

const EPS = 1e-9;

export function carObb(x, z, yaw, envelope) {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return {
    cx: x,
    cz: z,
    ux: c,
    uz: s,
    vx: -s,
    vz: c,
    hu: envelope.length / 2,
    hv: envelope.width / 2,
  };
}

function projectRadius(ax, az, ux, uz, vx, vz, hu, hv) {
  return Math.abs(ax * ux + az * uz) * hu + Math.abs(ax * vx + az * vz) * hv;
}

/**
 * SAT in XZ for two boxes. Returns the minimum-penetration axis whose normal
 * points from box B (collider) to box A (car), or null when separated.
 */
export function boxBoxContact(a, b) {
  const axes = [
    [a.ux, a.uz],
    [a.vx, a.vz],
    [b.ux, b.uz],
    [b.vx, b.vz],
  ];
  let best = null;
  for (let i = 0; i < axes.length; i++) {
    const [ax, az] = axes[i];
    const ra = projectRadius(ax, az, a.ux, a.uz, a.vx, a.vz, a.hu, a.hv);
    const rb = projectRadius(ax, az, b.ux, b.uz, b.vx, b.vz, b.hu, b.hv);
    const d = ax * (b.cx - a.cx) + az * (b.cz - a.cz);
    const pen = ra + rb - Math.abs(d);
    if (pen <= EPS) return null;
    if (best === null || pen < best.penetration - 1e-12) {
      // d > 0: B is on the +axis side of A, so the normal from B to A is -axis.
      const sign = d >= 0 ? -1 : 1;
      best = { penetration: pen, nx: ax * sign, nz: az * sign, axisIndex: i };
    }
  }
  return best;
}

function cellKey(ix, iz) {
  return `${ix},${iz}`;
}

/** Static collision world with a deterministic uniform-grid broadphase. */
export function createWorld(manifest, options = {}) {
  const cellSize = options.cellSize ?? 4;
  const profile = options.profile ?? "roadside";
  if (profile !== "roadside" && profile !== "all-visible") {
    throw new Error(`unknown collider profile "${profile}" (expected roadside or all-visible)`);
  }
  const colliders = [];
  const grid = new Map();
  const add = (ix, iz, index) => {
    const k = cellKey(ix, iz);
    let arr = grid.get(k);
    if (!arr) {
      arr = [];
      grid.set(k, arr);
    }
    arr.push(index);
  };
  for (const c of manifest.colliders) {
    // `active:false` marks a mapped collider that overlaps the measured course.
    // It is kept in the manifest for provenance/profile selection, never
    // silently dropped from the data.
    if (profile !== "all-visible" && c.active === false) continue;
    const ux = c.axes[0][0];
    const uz = c.axes[0][2];
    const vx = c.axes[2][0];
    const vz = c.axes[2][2];
    const lu = Math.hypot(ux, uz) || 1;
    const lv = Math.hypot(vx, vz) || 1;
    const u = [ux / lu, uz / lu];
    const v = [vx / lv, vz / lv];
    const halfU = c.half[0] * lu;
    const halfV = c.half[2] * lv;
    const radius = Math.abs(u[0]) * halfU + Math.abs(v[0]) * halfV;
    const radiusZ = Math.abs(u[1]) * halfU + Math.abs(v[1]) * halfV;
    const entry = {
      index: colliders.length,
      id: c.id,
      classification: c.classification,
      cx: c.center[0],
      cz: c.center[2],
      ux: u[0],
      uz: u[1],
      vx: v[0],
      vz: v[1],
      hu: halfU,
      hv: halfV,
      bottom: c.vertical.bottom,
      top: c.vertical.top,
      // world-space AABB of the XZ footprint, for the broadphase only
      minX: c.center[0] - radius,
      maxX: c.center[0] + radius,
      minZ: c.center[2] - radiusZ,
      maxZ: c.center[2] + radiusZ,
      triangles: c.triangles,
    };
    colliders.push(entry);
    for (let ix = Math.floor(entry.minX / cellSize); ix <= Math.floor(entry.maxX / cellSize); ix++) {
      for (let iz = Math.floor(entry.minZ / cellSize); iz <= Math.floor(entry.maxZ / cellSize); iz++) {
        add(ix, iz, entry.index);
      }
    }
  }

  function queryIndices(minX, maxX, minZ, maxZ) {
    const set = new Set();
    for (let ix = Math.floor(minX / cellSize); ix <= Math.floor(maxX / cellSize); ix++) {
      for (let iz = Math.floor(minZ / cellSize); iz <= Math.floor(maxZ / cellSize); iz++) {
        const arr = grid.get(cellKey(ix, iz));
        if (arr) for (const i of arr) set.add(i);
      }
    }
    return [...set].sort((a, b) => a - b);
  }

  /**
   * Deepest contact for a car pose, or null.  `baseY` is the car's ground
   * plane; the car body occupies [baseY, baseY + carEnvelope.height].
   */
  function deepestContact(x, z, yaw, baseY, carEnvelope) {
    const car = carObb(x, z, yaw, carEnvelope);
    const r = Math.hypot(car.hu, car.hv);
    const indices = queryIndices(x - r, x + r, z - r, z + r);
    const carTop = baseY + carEnvelope.height;
    let best = null;
    for (const i of indices) {
      const b = colliders[i];
      if (b.top <= baseY || b.bottom >= carTop) continue;
      const contact = boxBoxContact(car, b);
      if (contact && (best === null || contact.penetration > best.penetration + 1e-12)) {
        best = {
          ...contact,
          colliderIndex: i,
          colliderId: b.id,
          classification: b.classification,
          carTop,
        };
      }
    }
    return best;
  }

  /** All overlaps at a pose (used to mark every collider on the measured line). */
  function contactsAll(x, z, yaw, baseY, carEnvelope) {
    const car = carObb(x, z, yaw, carEnvelope);
    const r = Math.hypot(car.hu, car.hv);
    const indices = queryIndices(x - r, x + r, z - r, z + r);
    const carTop = baseY + carEnvelope.height;
    const out = [];
    for (const i of indices) {
      const b = colliders[i];
      if (b.top <= baseY || b.bottom >= carTop) continue;
      const contact = boxBoxContact(car, b);
      if (contact) {
        out.push({
          ...contact,
          colliderIndex: i,
          colliderId: b.id,
          classification: b.classification,
        });
      }
    }
    return out;
  }

  /** Any overlap (used by the corridor test). */
  function overlaps(x, z, yaw, baseY, carEnvelope) {
    return deepestContact(x, z, yaw, baseY, carEnvelope) !== null;
  }

  /**
   * Push a pose out of all static colliders without changing velocity.
   * Returns the resolved pose, the contacts that were used, and a residual
   * penetration (0 when clear).
   */
  function resolvePose(x, z, yaw, baseY, carEnvelope, options = {}) {
    const maxIterations = options.maxIterations ?? 12;
    const slop = options.slop ?? 0;
    const contacts = [];
    let residual = 0;
    for (let iter = 0; iter < maxIterations; iter++) {
      const contact = deepestContact(x, z, yaw, baseY, carEnvelope);
      if (!contact) {
        residual = 0;
        break;
      }
      const push = contact.penetration + slop;
      x += contact.nx * push;
      z += contact.nz * push;
      contacts.push({
        colliderId: contact.colliderId,
        classification: contact.classification,
        penetration: contact.penetration,
        normal: [contact.nx, contact.nz],
      });
      residual = 0;
    }
    if (!contacts.length) {
      const last = deepestContact(x, z, yaw, baseY, carEnvelope);
      residual = last ? last.penetration : 0;
    }
    return { x, z, residual, contacts };
  }

  /**
   * One fixed tick of motion + collision response.
   *
   * state: { x, z, y, yaw, vx, vz }  (y is the ground plane)
   * options: { dt, restitution, friction, maxSubstep, maxIterations, slop }
   */
  function step(state, options = {}) {
    const dt = options.dt ?? 1 / 60;
    const restitution = options.restitution ?? 0;
    const friction = options.friction ?? 0.45;
    const maxSubstep = options.maxSubstep ?? 0.08;
    const maxIterations = options.maxIterations ?? 6;
    const slop = options.slop ?? 0.001;
    const envelope = options.carEnvelope ?? manifest.carEnvelope;

    let { x, z, y, yaw, vx, vz } = state;
    let speed = Math.hypot(vx, vz);
    const substeps = Math.max(1, Math.min(64, Math.ceil((speed * dt) / maxSubstep)));
    const subDt = dt / substeps;
    const contactIds = [];
    let maxPenetration = 0;
    let resolvedContacts = 0;

    for (let s = 0; s < substeps; s++) {
      x += vx * subDt;
      z += vz * subDt;
      speed = Math.hypot(vx, vz);
      yaw = speed > 1e-9 ? Math.atan2(vz, vx) : yaw;

      for (let iter = 0; iter < maxIterations; iter++) {
        const contact = deepestContact(x, z, yaw, y, envelope);
        if (!contact) break;
        if (contact.penetration > maxPenetration) maxPenetration = contact.penetration;
        resolvedContacts += 1;
        // Positional push-out along the minimum-penetration axis.
        const push = contact.penetration + slop;
        x += contact.nx * push;
        z += contact.nz * push;
        // Velocity response: remove inward normal velocity, then Coulomb
        // friction on the tangential component.
        const vn = vx * contact.nx + vz * contact.nz;
        if (vn < 0) {
          const jn = -(1 + restitution) * vn;
          vx += contact.nx * jn;
          vz += contact.nz * jn;
          const tx = vx - (vx * contact.nx + vz * contact.nz) * contact.nx;
          const tz = vz - (vx * contact.nx + vz * contact.nz) * contact.nz;
          const vt = Math.hypot(tx, tz);
          if (vt > 1e-9) {
            const drop = Math.min(vt, friction * jn);
            vx -= (tx / vt) * drop;
            vz -= (tz / vt) * drop;
          }
        }
        if (!contactIds.includes(contact.colliderId)) contactIds.push(contact.colliderId);
      }
    }

    return {
      state: { x, z, y, yaw, vx, vz },
      substeps,
      maxPenetration,
      resolvedContacts,
      contactIds,
    };
  }

  return {
    profile,
    colliders,
    cellSize,
    queryIndices,
    deepestContact,
    contactsAll,
    overlaps,
    resolvePose,
    step,
    colliderById(id) {
      return colliders.find((c) => c.id === id) ?? null;
    },
  };
}

export { EPS };
