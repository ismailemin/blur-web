// Sprint layout for the E1 drive slice.
//
// The drive slice draws the real River block56/node289 direct draws over a
// segment of the collision mesh. That measured segment is the only honest place
// to put race gates: a gate that sits on a collision triangle with no committed
// real draw would be a gate over invisible ground, and the docs already record
// that the drawn road ends around x = -48 for the car's line.
//
// Everything below is derived from `geometry.json` and the spawn, never typed in
// as a coordinate:
//
//   * the sprint corridor is the spawn z +/- `bandHalfWidth` (6 m wide gates);
//   * a column (constant x across the corridor) is "covered" when every 0.1 m
//     sample has BOTH a real block56/node289 triangle over it in XZ and a
//     collision triangle under it (the surface the wheels trace);
//   * the finish is the last fully covered column minus `finishClearance`, so the
//     car never has to cross a gate whose line leaves the drawn road;
//   * the start is the spawn (the job's "start line at spawn");
//   * the checkpoints are the 1/3 and 2/3 points of that measured span, snapped
//     down to a 0.25 m grid so the layout has no floating-point coordinates.
//
// This module is shared by tools/build_sprint.mjs (writes sprint.json),
// tools/verify_e1_drive.mjs (re-derives and compares) and the page (validates
// the file it loads against its own hash and the reported coverage).

import { hashOf } from './packet-hash.js';

export const SPRINT_LAYOUT_KIND = 'e1-drive.sprint';
export const SPRINT_LAYOUT_VERSION = 1;

/** Half-width of every gate, measured from the spawn z. */
export const GATE_BAND_HALF_WIDTH = 3.0;
/** The finish is this far before the last fully covered column. */
export const FINISH_CLEARANCE_METRES = 2.0;
/** Gate x coordinates are snapped to this grid. */
export const GATE_X_GRID = 0.25;
/** Spacing of the coverage samples across a gate line. */
export const GATE_SAMPLE_STEP = 0.1;
/** Spacing of the covered-column scan along +X. */
export const COLUMN_STEP = 0.25;
/** Checkpoints along the measured span (2 of them: start + 2 CPs + finish). */
export const CHECKPOINT_FRACTIONS = Object.freeze([1 / 3, 2 / 3]);
/** Countdown: 1.5 s, three 0.5 s steps (3, 2, 1) at the fixed 60 Hz tick. */
export const COUNTDOWN_TICKS = 90;
export const COUNTDOWN_STEP_TICKS = 30;

const DRAWN_SECTION_KEY = 'river.block56.node289';

/** Map a key to a finite number of decimals, so hashes are stable across runs. */
const round6 = (value) => Math.round(value * 1e6) / 1e6;

/**
 * Triangles of one track-visual section, in source world space. Only the
 * drive-covering section is accepted: block88/node283 lies three kilometres away
 * and cannot cover a gate, and silently mixing it in would hide that.
 */
export function drawnTriangles(geometry) {
  const track = geometry?.trackVisual;
  if (!track || track.label !== 'asset-reader-direct-draws') {
    throw new Error('geometry does not carry the real track visual; rebuild geometry.json');
  }
  const section = track.sections?.find((entry) => entry.key === DRAWN_SECTION_KEY);
  if (!section) throw new Error('the drive-covering section ' + DRAWN_SECTION_KEY + ' is missing');
  const mesh = geometry.meshes?.find((entry) => entry.id === track.meshId);
  if (!mesh) throw new Error('the track visual mesh ' + track.meshId + ' is missing');
  const draws = track.draws.slice(section.drawIndexRange[0], section.drawIndexRange[1] + 1);
  const triangles = [];
  for (const draw of draws) {
    for (let offset = draw.indexOffset; offset < draw.indexOffset + draw.indexCount; offset += 3) {
      const a = mesh.indices[offset];
      const b = mesh.indices[offset + 1];
      const c = mesh.indices[offset + 2];
      const triangle = [
        [mesh.positions[a * 3], mesh.positions[a * 3 + 1], mesh.positions[a * 3 + 2]],
        [mesh.positions[b * 3], mesh.positions[b * 3 + 1], mesh.positions[b * 3 + 2]],
        [mesh.positions[c * 3], mesh.positions[c * 3 + 1], mesh.positions[c * 3 + 2]]
      ];
      triangles.push(triangle);
    }
  }
  if (triangles.length !== section.triangleCount) {
    throw new Error(DRAWN_SECTION_KEY + ' has ' + triangles.length + ' triangles, record says ' + section.triangleCount);
  }
  return { section, triangles };
}

/** Collision triangles (the surface the wheels trace) from the hidden surface. */
export function collisionTriangles(geometry) {
  const surface = geometry?.collisionSurface;
  if (!surface?.mesh) throw new Error('geometry has no hidden collision surface');
  const mesh = surface.mesh;
  const triangles = [];
  for (let offset = 0; offset < mesh.indices.length; offset += 3) {
    const a = mesh.indices[offset];
    const b = mesh.indices[offset + 1];
    const c = mesh.indices[offset + 2];
    triangles.push([
      [mesh.positions[a * 3], mesh.positions[a * 3 + 1], mesh.positions[a * 3 + 2]],
      [mesh.positions[b * 3], mesh.positions[b * 3 + 1], mesh.positions[b * 3 + 2]],
      [mesh.positions[c * 3], mesh.positions[c * 3 + 1], mesh.positions[c * 3 + 2]]
    ]);
  }
  return triangles;
}

/**
 * Point-in-triangle test in XZ; returns the triangle's height at (x, z) or null.
 * Uses the same plane form as build_geometry.mjs' coverage test so the two
 * measurements agree by construction.
 */
export function heightInTriangle(triangle, x, z) {
  const ax = triangle[0][0], ay = triangle[0][1], az = triangle[0][2];
  const bx = triangle[1][0], by = triangle[1][1], bz = triangle[1][2];
  const cx = triangle[2][0], cy = triangle[2][1], cz = triangle[2][2];
  const den = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
  if (Math.abs(den) < 1e-12) return null;
  const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / den;
  const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / den;
  const l3 = 1 - l1 - l2;
  if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) return null;
  return l1 * ay + l2 * by + l3 * cy;
}

/**
 * X-bucketed triangle index. A gate scan would test 9,824 drawn triangles per
 * sample without it; the buckets keep the derivation fast enough to run in the
 * verifier and stay deterministic (insertion order, no hash of floats).
 */
export class TriangleIndex {
  constructor(triangles, bucketSize = 2) {
    this.bucketSize = bucketSize;
    this.buckets = new Map();
    this.triangles = triangles;
    for (const triangle of triangles) {
      const xs = triangle.map((vertex) => vertex[0]);
      const first = Math.floor(Math.min(...xs) / bucketSize);
      const last = Math.floor(Math.max(...xs) / bucketSize);
      for (let bucket = first; bucket <= last; bucket++) {
        let list = this.buckets.get(bucket);
        if (!list) { list = []; this.buckets.set(bucket, list); }
        list.push(triangle);
      }
    }
  }

  /** Highest triangle height at (x, z), or null when no triangle contains it. */
  heightAt(x, z) {
    const list = this.buckets.get(Math.floor(x / this.bucketSize));
    if (!list) return null;
    let best = null;
    for (const triangle of list) {
      const height = heightInTriangle(triangle, x, z);
      if (height !== null && (best === null || height > best)) best = height;
    }
    return best;
  }

  /** Every triangle containing (x, z), with its height. */
  at(x, z) {
    const list = this.buckets.get(Math.floor(x / this.bucketSize));
    if (!list) return [];
    const hits = [];
    for (const triangle of list) {
      const height = heightInTriangle(triangle, x, z);
      if (height !== null) hits.push({ triangle, height });
    }
    return hits;
  }
}

/** One column across the corridor: every sample must be drawn AND physical. */
export function columnCoverage(columnX, layout, drawn, collision) {
  const { z0, halfWidth } = layout;
  const count = Math.round((2 * halfWidth) / GATE_SAMPLE_STEP) + 1;
  let drawnHits = 0;
  let collisionHits = 0;
  let drawnMin = Infinity, drawnMax = -Infinity;
  let collisionMin = Infinity, collisionMax = -Infinity;
  const missing = [];
  for (let sample = 0; sample < count; sample++) {
    const z = round6(z0 - halfWidth + sample * GATE_SAMPLE_STEP);
    const drawnHeight = drawn.heightAt(columnX, z);
    const collisionHeight = collision.heightAt(columnX, z);
    if (drawnHeight === null) missing.push({ z, missing: 'drawn' });
    else { drawnHits++; drawnMin = Math.min(drawnMin, drawnHeight); drawnMax = Math.max(drawnMax, drawnHeight); }
    if (collisionHeight === null) missing.push({ z, missing: 'collision' });
    else { collisionHits++; collisionMin = Math.min(collisionMin, collisionHeight); collisionMax = Math.max(collisionMax, collisionHeight); }
  }
  return {
    x: round6(columnX),
    samples: count,
    drawnSamples: drawnHits,
    collisionSamples: collisionHits,
    covered: missing.length === 0,
    missing: missing.slice(0, 8),
    drawnHeightRange: drawnHits ? [round6(drawnMin), round6(drawnMax)] : null,
    collisionHeightRange: collisionHits ? [round6(collisionMin), round6(collisionMax)] : null
  };
}

function snapStraightToGrid(x, grid) {
  return round6(Math.round(x / grid) * grid);
}

function snapDownToGrid(x, grid) {
  return round6(Math.floor(x / grid + 1e-9) * grid);
}

function gateRecord(kind, index, id, x, z0, halfWidth, drawn, collision) {
  const coverage = columnCoverage(x, { z0, halfWidth }, drawn, collision);
  return {
    id,
    kind,
    index,
    x: round6(x),
    z: round6(z0),
    a: [round6(x), round6(z0 - halfWidth)],
    b: [round6(x), round6(z0 + halfWidth)],
    widthMetres: round6(halfWidth * 2),
    coverage
  };
}

/**
 * Derive the sprint layout. `spawn` is the committed spawn ({x, z, heading});
 * options exist for tests but the committed tool never overrides the corridor.
 */
export function deriveSprintLayout(geometry, spawn, options = {}) {
  const halfWidth = options.bandHalfWidthMetres ?? GATE_BAND_HALF_WIDTH;
  const clearance = options.finishClearanceMetres ?? FINISH_CLEARANCE_METRES;
  const grid = options.gateXGridMetres ?? GATE_X_GRID;
  const fractions = options.checkpointFractions ?? CHECKPOINT_FRACTIONS;
  if (!(halfWidth > 0) || !(clearance >= 0) || !(grid > 0)) {
    throw new Error('sprint layout options are invalid');
  }
  if (!Array.isArray(fractions) || fractions.length < 2 || fractions.length > 3 ||
      fractions.some((fraction) => !(fraction > 0 && fraction < 1))) {
    throw new Error('sprint layout needs two or three checkpoint fractions inside (0, 1)');
  }
  if (!spawn || !Number.isFinite(spawn.x) || !Number.isFinite(spawn.z) || !Number.isFinite(spawn.heading)) {
    throw new Error('sprint layout needs the finite committed spawn');
  }

  const { section, triangles: drawnTrianglesList } = drawnTriangles(geometry);
  const collisionTrianglesList = collisionTriangles(geometry);
  const drawn = new TriangleIndex(drawnTrianglesList);
  const collision = new TriangleIndex(collisionTrianglesList);

  const z0 = spawn.z;
  const startX = spawn.x;

  // Scan +X while the whole gate band is covered. A failure stops the scan: the
  // covered segment is contiguous from the spawn (measured; no gap is expected,
  // and a gap is reported rather than jumped over).
  const columns = [];
  let lastCoveredX = null;
  for (let step = 0; step <= 400; step++) {
    const x = snapStraightToGrid(startX + step * COLUMN_STEP, grid);
    const coverage = columnCoverage(x, { z0, halfWidth }, drawn, collision);
    if (!coverage.covered) {
      columns.push({ ...coverage, covered: false });
      break;
    }
    columns.push(coverage);
    lastCoveredX = x;
  }
  if (lastCoveredX === null) {
    throw new Error('no covered sprint column at the spawn ' + startX + ',' + z0);
  }
  const spanLength = lastCoveredX - startX;
  if (spanLength < 10) {
    throw new Error('covered sprint span is only ' + spanLength.toFixed(2) + ' m; no sprint can be laid out');
  }

  const finishX = snapDownToGrid(lastCoveredX - clearance, grid);
  if (!(finishX > startX + 5)) {
    throw new Error('finish ' + finishX + ' leaves less than 5 m of sprint');
  }

  const gateXs = [startX];
  for (const fraction of fractions) {
    const snapped = snapStraightToGrid(startX + (finishX - startX) * fraction, grid);
    if (!(snapped > gateXs[gateXs.length - 1] + 0.5) || snapped > finishX - 0.5) {
      throw new Error('checkpoint fraction ' + fraction + ' snapped out of order at ' + snapped);
    }
    gateXs.push(snapped);
  }
  gateXs.push(finishX);

  const gates = [
    gateRecord('start', 0, 'start', gateXs[0], z0, halfWidth, drawn, collision),
    ...gateXs.slice(1, -1).map((x, index) =>
      gateRecord('checkpoint', index + 1, 'checkpoint-' + (index + 1), x, z0, halfWidth, drawn, collision)),
    gateRecord('finish', gateXs.length - 1, 'finish', gateXs[gateXs.length - 1], z0, halfWidth, drawn, collision)
  ];
  for (const gate of gates) {
    if (!gate.coverage.covered) {
      throw new Error('gate ' + gate.id + ' at x=' + gate.x + ' is not fully covered');
    }
  }

  // Ground height for the fall rule: the highest collision triangle at the spawn
  // (the same surface the wheel probe hits). The engine's own probe is compared
  // against this by the verifier.
  const spawnGroundY = collision.heightAt(spawn.x, spawn.z);
  if (spawnGroundY === null) throw new Error('no collision triangle at the spawn');

  // Evidence columns every metre along the measured span (all covered).
  const measuredColumns = [];
  for (let x = startX; x <= finishX + 1e-9; x += 1) {
    const rounded = round6(x);
    const coverage = columns.find((column) => Math.abs(column.x - rounded) < 1e-9) ??
      columnCoverage(rounded, { z0, halfWidth }, drawn, collision);
    measuredColumns.push({
      x: rounded,
      covered: coverage.covered,
      drawnSamples: coverage.drawnSamples,
      collisionSamples: coverage.collisionSamples,
      drawnHeightRange: coverage.drawnHeightRange
    });
  }

  const layout = {
    kind: SPRINT_LAYOUT_KIND,
    version: SPRINT_LAYOUT_VERSION,
    source: {
      geometry: '_work/e1-drive/geometry.json',
      geometryVersion: geometry.version,
      drawnSection: DRAWN_SECTION_KEY,
      drawnSectionReference: section.reference,
      drawnSectionReferenceSha256: section.referenceSha256,
      trackVisual: geometry.trackVisual.label,
      spawn: { x: spawn.x, z: spawn.z, headingRad: spawn.heading },
      spawnSource: spawn.source ?? null
    },
    course: {
      rule:
        'the sprint runs on the measured covered segment under the spawn corridor: a column is covered when every ' +
        GATE_SAMPLE_STEP + ' m sample across the gate band has both a real ' + DRAWN_SECTION_KEY +
        ' triangle over it and a collision triangle under it; the finish is the last covered column minus ' +
        clearance + ' m, and the checkpoints are the ' + fractions.length + ' requested fractions of that span',
      spawn: { x: round6(startX), z: round6(z0), headingRad: spawn.heading },
      spawnGroundY: round6(spawnGroundY),
      band: { z: round6(z0), halfWidthMetres: round6(halfWidth), gateWidthMetres: round6(halfWidth * 2) },
      span: {
        startX: round6(startX),
        finishX: round6(finishX),
        lengthMetres: round6(finishX - startX),
        lastFullyCoveredX: round6(lastCoveredX),
        finishClearanceMetres: round6(clearance),
        drawnGroundEndsNote:
          'the last fully covered column is where the committed real draw stops covering the gate band; the ' +
          'finish is placed before it so the car never has to cross a gate line that leaves the drawn road'
      },
      sampling: {
        columnStepMetres: COLUMN_STEP,
        gateSampleStepMetres: GATE_SAMPLE_STEP,
        gateXGridMetres: grid
      },
      columns: measuredColumns
    },
    gates,
    countdown: {
      ticks: COUNTDOWN_TICKS,
      stepTicks: COUNTDOWN_STEP_TICKS,
      labels: ['3', '2', '1'],
      goLabel: 'GO',
      rule: 'input is held at zero until the countdown reaches GO; the timer starts at GO and the car is on the start line'
    },
    rules: {
      tickHz: 60,
      timer: 'elapsed engine ticks from GO at 1/60 s; it keeps running across a respawn and freezes on the finish',
      gateOrder: 'checkpoints count only in index order; a finish crossing is rejected until every checkpoint is passed',
      finishRequiresAllCheckpoints: true,
      respawn: {
        fallBelowGroundMetres: 1.0,
        airborneTicks: 30,
        outsideBandMarginMetres: 1.0,
        overshootMarginMetres: 2.0,
        target: 'the last passed checkpoint gate (the start line before the first checkpoint)',
        rule: 'respawn when the chassis falls more than 1 m below the measured spawn ground, stays airborne for ' +
          '30 ticks, or leaves the gate corridor; the attempt timer keeps running and the last checkpoint is kept'
      },
      limits: [
        'this is one point-to-point sprint on the measured covered segment, not a lap: the real River draws do not cover a lap',
        'gates are rules geometry only; no gate mesh is added to the render packet',
        'no opponents, no AI and no race audio'
      ]
    }
  };
  layout.hash = hashOf(layout);
  return layout;
}

/**
 * Structural validation used by the page. The verifier additionally re-derives
 * the layout and proves it matches the file byte for byte.
 */
export function validateSprintLayout(layout, geometry, spawn) {
  const errors = [];
  const fail = (message) => errors.push(message);
  if (!layout || layout.kind !== SPRINT_LAYOUT_KIND) fail('layout kind is not ' + SPRINT_LAYOUT_KIND);
  if (layout?.version !== SPRINT_LAYOUT_VERSION) fail('layout version is not ' + SPRINT_LAYOUT_VERSION);
  if (typeof layout?.hash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(layout.hash)) fail('layout hash is missing');
  else {
    const body = { ...layout };
    delete body.hash;
    if (hashOf(body) !== layout.hash) fail('layout hash does not match its content (hand-edited sprint.json?)');
  }
  if (geometry && layout?.source?.geometryVersion !== geometry.version) {
    fail('layout was built from geometry v' + layout?.source?.geometryVersion + ', loaded v' + geometry.version);
  }
  if (geometry && layout?.source?.trackVisual !== geometry.trackVisual?.label) {
    fail('layout track visual label does not match the loaded geometry');
  }
  if (spawn && layout?.source?.spawn) {
    for (const axis of ['x', 'z']) {
      if (Math.abs(layout.source.spawn[axis] - spawn[axis]) > 1e-9) {
        fail('layout spawn ' + axis + ' ' + layout.source.spawn[axis] + ' differs from the page spawn ' + spawn[axis]);
      }
    }
    if (Math.abs(layout.source.spawn.headingRad - spawn.heading) > 1e-12) {
      fail('layout spawn heading differs from the page spawn');
    }
  }
  const gates = layout?.gates;
  if (!Array.isArray(gates) || gates.length < 3 || gates.length > 5) {
    fail('layout needs a start, two or three checkpoints and a finish');
  } else {
    if (gates[0].kind !== 'start' || gates[gates.length - 1].kind !== 'finish') fail('layout gate order is not start..finish');
    const checkpoints = gates.filter((gate) => gate.kind === 'checkpoint');
    if (checkpoints.length < 2 || checkpoints.length > 3) fail('layout needs two or three checkpoints');
    for (let index = 0; index < gates.length; index++) {
      const gate = gates[index];
      if (gate.index !== index) fail('gate ' + gate.id + ' has index ' + gate.index + ', expected ' + index);
      if (!Number.isFinite(gate.x) || !Array.isArray(gate.a) || !Array.isArray(gate.b)) fail('gate ' + gate.id + ' is malformed');
      if (index > 0 && !(gate.x > gates[index - 1].x)) fail('gate ' + gate.id + ' is not ahead of the previous gate');
      if (gate.coverage?.covered !== true) fail('gate ' + gate.id + ' is not fully covered');
    }
    const span = layout?.course?.span;
    if (!span || !(gates[0].x === span.startX) || !(gates[gates.length - 1].x === span.finishX)) {
      fail('gate x positions do not match the measured span');
    } else if (!(span.finishX < span.lastFullyCoveredX)) {
      fail('the finish is not before the last fully covered column');
    }
  }
  return { ok: errors.length === 0, errors };
}
