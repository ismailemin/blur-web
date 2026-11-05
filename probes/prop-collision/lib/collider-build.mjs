/*
 * collider-build.mjs — derive a static prop-collision layer from the visible
 * E1 geometry v6.
 *
 * Scope is deliberately narrow and stated in the manifest:
 *   - only VISIBLE mesh geometry (level props + merged track visual) is used;
 *   - the hidden physics collision surface is used only to measure the local
 *     ground height, never as a collider source;
 *   - the player car mesh, the road/terrain surface and all geometry farther
 *     than `regionDistance` from the measured 310 m course are excluded.
 *
 * This is an approximation of retail prop collision.  It is not retail data and
 * the manifest says so.
 */

import crypto from "node:crypto";
import {
  meshAccessor,
  drawComponents,
  groupVertices,
  instanceObb,
  makeGroundSampler,
} from "./geometry.mjs";
import { minAreaRect2D, obbCorners2D, pointPolylineDistance2D } from "./geom2d.mjs";
import { createWorld } from "./resolver.mjs";

export const CAR_ENVELOPE = Object.freeze({
  length: 2.98,
  width: 1.68,
  height: 1.35,
  source:
    "documented maximum XT envelope from the Blur Web vehicle work (largest roster wheelbase 2.981 m); " +
    "the resolver uses a 2.98 x 1.68 m rectangle and a 1.35 m body height, not a recovered retail hull",
});

export const DEFAULTS = Object.freeze({
  regionDistance: 30,
  minVerticalExtent: 0.25,
  minColliderThickness: 0.02,
  overheadClearance: 1.5,
  flushHeight: 0.2,
});

const TERRAIN_PATTERNS = [
  /tarmac/i, /kerb/i, /mud/i, /offroad/i, /grounddirt/i, /dirtmount/i,
  /grass/i, /mountbaked/i, /riverbasin/i, /bankwall/i, /reed/i, /treeline/i,
  /cleanslate/i, /sand/i, /gravel/i, /mudsidewall/i,
];

const GROUND_SURFACE_PATTERNS = [
  /concretefloorsmooth/i, /pavement/i, /paving/i, /sidewalk/i, /metalwalkway/i,
];

const VEHICLE_PATTERNS = [
  /treetruck/i, /truck/i, /vehicle/i, /trailer/i, /tractor/i, /bus/i,
  /van_/i, /wreck/i, /car_/i,
];

const BUILDING_PATTERNS = [
  /building/i, /^b\d+_/i, /roof/i, /window/i, /door/i, /balc/i, /shutter/i,
  /entrance/i, /glass/i, /wallmaintile/i,
];

const STRUCTURE_PATTERNS = [
  /fence/i, /barrier/i, /container/i, /cargo/i, /pipe/i, /pole/i, /pylon/i,
  /crane/i, /girder/i, /bridge/i, /gate/i, /hopper/i, /extractor/i, /metal/i,
  /steel/i, /vent/i, /sign/i, /plantpot/i, /brick/i, /wall/i, /rust/i,
  /weatheredgrime/i, /wooden/i, /boards/i, /concrete/i, /channel/i, /decor/i,
];

/** Texture-name classification.  Returns {kind, reason}. */
export function classifyTexture(name) {
  if (!name) return { kind: "no-material", reason: "draw has no texture binding row" };
  if (VEHICLE_PATTERNS.some((re) => re.test(name))) {
    return { kind: "vehicle", reason: "texture name matches a vehicle/prop pattern" };
  }
  if (TERRAIN_PATTERNS.some((re) => re.test(name))) {
    return { kind: "terrain", reason: "texture name matches the road/terrain pattern set" };
  }
  if (GROUND_SURFACE_PATTERNS.some((re) => re.test(name))) {
    return { kind: "ground-surface", reason: "texture name matches the pavement/floor pattern set" };
  }
  if (BUILDING_PATTERNS.some((re) => re.test(name))) {
    return { kind: "building", reason: "texture name matches the building pattern set" };
  }
  if (STRUCTURE_PATTERNS.some((re) => re.test(name))) {
    return { kind: "structure", reason: "texture name matches the structure pattern set" };
  }
  return { kind: "unclassified", reason: "texture name matches no classification pattern" };
}

/** Shape class for a level prop, which carries no texture/material binding. */
export function classifyLevelShape(size) {
  const height = size[1];
  const footprint = size[0] * size[2];
  if (height <= 2.1 && footprint <= 40) {
    return { kind: "vehicle-sized-wreck", reason: "height <= 2.1 m and footprint <= 40 m2; no material binding" };
  }
  if (height > 2.1) {
    return { kind: "building-sized", reason: "height > 2.1 m; no material binding" };
  }
  return { kind: "unclassified", reason: "shape matches neither the vehicle-sized nor the building-sized rule" };
}

const round6 = (v) => Math.round(v * 1e6) / 1e6;
const rv = (arr) => arr.map(round6);

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

export function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function obbRecord({ id, type, source, center, axes, half, classification, classReason, provenance, ground, courseDistance, triangles, worldAabb }) {
  const bottom = center[1] - half[1];
  const top = center[1] + half[1];
  return {
    id,
    type,
    source,
    center: rv(center),
    axes: axes.map(rv),
    half: rv(half),
    size: rv(half.map((h) => h * 2)),
    worldAabb: { min: rv(worldAabb.min), max: rv(worldAabb.max) },
    vertical: {
      bottom: round6(bottom),
      top: round6(top),
      height: round6(top - bottom),
      groundY: ground ? round6(ground.y) : null,
      groundExact: ground ? ground.exact : null,
      bottomAboveGround: ground ? round6(bottom - ground.y) : null,
      topAboveGround: ground ? round6(top - ground.y) : null,
    },
    classification,
    classificationReason: classReason,
    distanceToCourse: round6(courseDistance),
    triangles,
    provenance,
  };
}

function unionAabb(a, b) {
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
  };
}

/**
 * Build the manifest.  Pure function of (geometry, pathData, options).
 */
export function buildColliderManifest(geometry, pathData, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const course = pathData.course.points;
  const groundAt = makeGroundSampler(geometry.collisionSurface.mesh);

  const levelMesh = geometry.meshes.find((m) => m.id === "river.block27.instances-all");
  const trackMesh = geometry.meshes.find((m) => m.id === "river.track.visual");
  if (!levelMesh) throw new Error("geometry has no river.block27.instances-all mesh");
  if (!trackMesh) throw new Error("geometry has no river.track.visual mesh");
  const levelAcc = meshAccessor(levelMesh);
  const trackAcc = meshAccessor(trackMesh);

  const colliders = [];
  const excluded = [];
  const excludedCounts = new Map();
  const outOfRegionCounts = new Map();
  const classCounts = new Map();
  const addExcluded = (row) => {
    excluded.push(row);
    excludedCounts.set(row.reason, (excludedCounts.get(row.reason) ?? 0) + 1);
  };
  const addOutOfRegion = (kind) => {
    outOfRegionCounts.set(kind, (outOfRegionCounts.get(kind) ?? 0) + 1);
  };
  const addClass = (kind) => classCounts.set(kind, (classCounts.get(kind) ?? 0) + 1);

  // ---- level instances -------------------------------------------------
  // One source instance = one matrix placement.  Several draws may belong to
  // the same placement (body + glass + wheels), so the matrix is the key.
  const instanceGroups = new Map();
  for (const d of geometry.levelDraws) {
    const matrix = d.source.instanceMatrix;
    const key = matrix
      .slice(0, 12)
      .map((v) => v.toFixed(6))
      .join(",");
    if (!instanceGroups.has(key)) {
      instanceGroups.set(key, { matrix, draws: [], archivedBounds: d.source.archivedInstanceBounds });
    }
    instanceGroups.get(key).draws.push(d);
  }
  const instanceKeys = [...instanceGroups.keys()].sort();
  instanceKeys.forEach((key, index) => {
    const group = instanceGroups.get(key);
    const { vertices, min, max } = groupVertices(levelAcc, group.draws);
    const size = max.map((v, i) => v - min[i]);
    const shape = classifyLevelShape(size);
    const centerXZ = [(min[0] + max[0]) / 2, (min[2] + max[2]) / 2];
    const ground = groundAt(centerXZ[0], centerXZ[1]);
    const fit = instanceObb(levelAcc, vertices, group.matrix);
    const triangles = group.draws.reduce((n, d) => n + d.indexCount / 3, 0);
    if (!fit.ok) {
      addExcluded({
        id: `level.instance.${String(index).padStart(2, "0")}`,
        source: "level-instance",
        reason: "unfit-instance-matrix",
        detail: fit.reason,
        classification: shape.kind,
        size: rv(size),
      });
      return;
    }
    const corners = obbCorners2D(
      [fit.center[0], fit.center[2]],
      [fit.axes[0][0], fit.axes[0][2]],
      [fit.axes[2][0], fit.axes[2][2]],
      [fit.half[0], fit.half[2]],
    );
    const courseDistance = Math.min(...corners.map((p) => pointPolylineDistance2D(p[0], p[1], course)));
    if (courseDistance > opts.regionDistance) {
      addOutOfRegion(shape.kind);
      return;
    }
    const bottom = fit.center[1] - fit.half[1];
    const top = fit.center[1] + fit.half[1];
    if (top - ground.y <= opts.flushHeight) {
      addExcluded({
        id: `level.instance.${String(index).padStart(2, "0")}`,
        source: "level-instance",
        reason: "flush",
        detail: `top is ${(top - ground.y).toFixed(3)} m above the sampled ground`,
        classification: shape.kind,
      });
      return;
    }
    if (bottom - ground.y >= opts.overheadClearance) {
      addExcluded({
        id: `level.instance.${String(index).padStart(2, "0")}`,
        source: "level-instance",
        reason: "overhead",
        detail: `bottom is ${(bottom - ground.y).toFixed(3)} m above the sampled ground`,
        classification: shape.kind,
      });
      return;
    }
    addClass(shape.kind);
    colliders.push(
      obbRecord({
        id: `level.instance.${String(index).padStart(2, "0")}`,
        type: "obb",
        source: "level-instance",
        center: fit.center,
        axes: fit.axes,
        half: fit.half,
        classification: shape.kind,
        classReason: shape.reason,
        provenance: {
          meshId: levelMesh.id,
          drawIds: group.draws.map((d) => d.id).sort(),
          instanceMatrix: rv(group.matrix),
          instanceMatrixSource: "level_inspect.exe source placement; vertices are baked into the mesh",
          archivedInstanceBounds: rv(group.archivedBounds ?? []),
          worldBaked: true,
          instanceObbFit: "source instance matrix columns, extents from baked vertices",
          instanceMatrixOrthoResidual: round6(fit.orthoResidual),
          instanceMatrixDeterminant: round6(fit.determinant),
          vertexCount: vertices.length,
          size: rv(size),
        },
        ground,
        courseDistance,
        triangles,
        worldAabb: { min, max },
      }),
    );
  });

  // ---- track-visual connected components --------------------------------
  for (const draw of geometry.trackVisual.draws) {
    const name = draw.textureBinding?.name ?? null;
    const cls = classifyTexture(name);
    const comps = drawComponents(trackAcc, draw);
    for (let ci = 0; ci < comps.length; ci++) {
      const c = comps[ci];
      const id = `${draw.id}.component.${String(ci).padStart(3, "0")}`;
      const size = c.max.map((v, i) => v - c.min[i]);
      // Footprint distance uses the component hull, not the draw AABB.
      const unique = c.vertices.map((v) => [trackAcc.positions[3 * v], trackAcc.positions[3 * v + 2]]);
      const hullDist = Math.min(...unique.map((p) => pointPolylineDistance2D(p[0], p[1], course)));
      if (hullDist > opts.regionDistance) {
        addOutOfRegion(cls.kind);
        continue;
      }
      if (cls.kind === "terrain" || cls.kind === "ground-surface") {
        addExcluded({
          id, source: "track-visual", drawId: draw.id, meshId: trackMesh.id,
          reason: cls.kind === "terrain" ? "road-terrain" : "ground-surface",
          detail: cls.reason, texture: name, classification: cls.kind,
          size: rv(size), distanceToCourse: round6(hullDist),
        });
        continue;
      }
      if (size[1] < opts.minVerticalExtent) {
        addExcluded({
          id, source: "track-visual", drawId: draw.id, meshId: trackMesh.id,
          reason: "flat", detail: `vertical extent ${size[1].toFixed(3)} m < ${opts.minVerticalExtent} m`,
          texture: name, classification: cls.kind, size: rv(size), distanceToCourse: round6(hullDist),
        });
        continue;
      }
      const centerXZ = [(c.min[0] + c.max[0]) / 2, (c.min[2] + c.max[2]) / 2];
      const ground = groundAt(centerXZ[0], centerXZ[1]);
      if (c.max[1] - ground.y <= opts.flushHeight) {
        addExcluded({
          id, source: "track-visual", drawId: draw.id, meshId: trackMesh.id,
          reason: "flush", detail: `top is ${(c.max[1] - ground.y).toFixed(3)} m above the sampled ground`,
          texture: name, classification: cls.kind, size: rv(size), distanceToCourse: round6(hullDist),
        });
        continue;
      }
      if (c.min[1] - ground.y >= opts.overheadClearance) {
        addExcluded({
          id, source: "track-visual", drawId: draw.id, meshId: trackMesh.id,
          reason: "overhead", detail: `bottom is ${(c.min[1] - ground.y).toFixed(3)} m above the sampled ground`,
          texture: name, classification: cls.kind, size: rv(size), distanceToCourse: round6(hullDist),
        });
        continue;
      }
      const rect = minAreaRect2D(unique);
      const minHalf = opts.minColliderThickness / 2;
      const inflated = rect.half[0] < minHalf || rect.half[1] < minHalf;
      const half = [
        Math.max(rect.half[0], minHalf),
        Math.max((c.max[1] - c.min[1]) / 2, minHalf),
        Math.max(rect.half[1], minHalf),
      ];
      const center = [rect.center[0], (c.min[1] + c.max[1]) / 2, rect.center[1]];
      const axes = [
        [rect.u[0], 0, rect.u[1]],
        [0, 1, 0],
        [rect.v[0], 0, rect.v[1]],
      ];
      addClass(cls.kind);
      colliders.push(
        obbRecord({
          id,
          type: "obb",
          source: "track-visual",
          center,
          axes,
          half,
          classification: cls.kind,
          classReason: cls.reason,
          provenance: {
            meshId: trackMesh.id,
            drawId: draw.id,
            section: draw.source?.sourceSection ?? null,
            sectionReference: draw.source?.reference ?? null,
            texture: name,
            textureId: draw.textureId ?? null,
            drawIndexRange: [draw.indexOffset, draw.indexOffset + draw.indexCount],
            drawTriangleRange: [draw.indexOffset / 3, draw.indexOffset / 3 + draw.indexCount / 3],
            componentIndex: ci,
            componentTriangles: c.triangles,
            componentVertexCount: c.vertexCount,
            componentMin: rv(c.min),
            componentMax: rv(c.max),
            boxFit: "minimum-area rectangle over the component convex hull in XZ + vertical extent",
            boxAngleRad: round6(rect.angle),
            minimumThicknessInflated: inflated,
            identityWorld: true,
          },
          ground,
          courseDistance: hullDist,
          triangles: c.triangles,
          worldAabb: { min: c.min, max: c.max },
        }),
      );
    }
  }

  // Texture-name census over every track-visual draw, including the draws and
  // classes that end up outside the 30 m region.  This is what makes the
  // "unclassified" statement explicit rather than an absence.
  const textureCensus = new Map();
  const unclassifiedTextures = new Map();
  for (const draw of geometry.trackVisual.draws) {
    const name = draw.textureBinding?.name ?? null;
    const cls = classifyTexture(name);
    if (!textureCensus.has(cls.kind)) {
      textureCensus.set(cls.kind, { kind: cls.kind, draws: 0, triangles: 0, textures: new Set(), reason: cls.reason });
    }
    const row = textureCensus.get(cls.kind);
    row.draws += 1;
    row.triangles += draw.indexCount / 3;
    if (name) row.textures.add(name);
    if (cls.kind === "unclassified") {
      const key = name ?? "(none)";
      if (!unclassifiedTextures.has(key)) unclassifiedTextures.set(key, { texture: key, draws: 0, triangles: 0 });
      const u = unclassifiedTextures.get(key);
      u.draws += 1;
      u.triangles += draw.indexCount / 3;
    }
  }
  const textureCensusRows = [...textureCensus.values()]
    .map((r) => ({ kind: r.kind, draws: r.draws, triangles: r.triangles, distinctTextures: r.textures.size, reason: r.reason }))
    .sort((a, b) => (a.kind < b.kind ? -1 : 1));
  const unclassifiedRows = [...unclassifiedTextures.values()].sort((a, b) => (a.texture < b.texture ? -1 : 1));

  colliders.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  excluded.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // ---- measured-course conflict pass -----------------------------------
  // The committed 310 m course was measured on the collision-only surface and
  // predates prop collision.  Some visible props (pipes, fences, a metal rack)
  // lie on that measured line.  Colliding them would make the current course
  // impassable, so they are kept in the manifest as mapped colliders but
  // inactive in the default profile.  The all-visible profile can be selected
  // explicitly; its measured consequence is recorded here.
  const probeWorld = createWorld({ colliders, carEnvelope: CAR_ENVELOPE });
  const onCourse = new Map();
  const blockedSamples = new Set();
  for (let i = 0; i < course.length; i++) {
    const [x, z] = course[i];
    const a = course[Math.max(0, i - 1)];
    const b = course[Math.min(course.length - 1, i + 1)];
    const yaw = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const ground = groundAt(x, z);
    const hits = probeWorld.contactsAll(x, z, yaw, ground.y, CAR_ENVELOPE);
    if (hits.length) blockedSamples.add(i);
    for (const hit of hits) {
      const arc = (i * pathData.course.length) / (course.length - 1);
      const row = onCourse.get(hit.colliderId);
      if (!row) {
        onCourse.set(hit.colliderId, {
          colliderId: hit.colliderId,
          firstSample: i,
          lastSample: i,
          firstArc: arc,
          lastArc: arc,
          samples: 1,
          classification: hit.classification,
        });
      } else {
        row.lastSample = i;
        row.lastArc = arc;
        row.samples += 1;
      }
    }
  }
  const onCourseRows = [...onCourse.values()].sort((a, b) => (a.colliderId < b.colliderId ? -1 : 1));
  for (const c of colliders) {
    const row = onCourse.get(c.id);
    c.active = !row;
    if (row) {
      c.exclusion = {
        rule: "on-measured-course",
        reason:
          "the visible collider overlaps the car envelope on the measured 310 m course; " +
          "the committed course was measured on the collision-only surface and passes through this prop, " +
          "so colliding it would make the measured line impassable",
        firstArc: round6(row.firstArc),
        lastArc: round6(row.lastArc),
        samples: row.samples,
      };
    }
  }
  // Merge overlapping blocked intervals for the report.
  const intervals = onCourseRows
    .map((r) => ({ firstArc: r.firstArc, lastArc: r.lastArc, colliderId: r.colliderId }))
    .sort((a, b) => (a.firstArc === b.firstArc ? a.lastArc - b.lastArc : a.firstArc - b.firstArc));
  const blockedArcs = [];
  for (const row of intervals) {
    const last = blockedArcs[blockedArcs.length - 1];
    if (last && row.firstArc <= last.lastArc + 0.5) {
      last.lastArc = Math.max(last.lastArc, row.lastArc);
      last.colliderIds.add(row.colliderId);
    } else {
      blockedArcs.push({
        firstArc: row.firstArc,
        lastArc: row.lastArc,
        colliderIds: new Set([row.colliderId]),
      });
    }
  }
  const blockedArcReport = blockedArcs.map((a) => ({
    arcStart: round6(a.firstArc),
    arcEnd: round6(a.lastArc),
    colliders: a.colliderIds.size,
    colliderIds: [...a.colliderIds].sort(),
  }));

  const activeCount = colliders.filter((c) => c.active).length;
  const inactiveCount = colliders.length - activeCount;
  const onCourseCount = inactiveCount;
  for (const c of colliders) c.hash = `sha256:${sha256(stableStringify(c))}`;

  const bounds = colliders.reduce(
    (acc, c) => unionAabb(acc, c.worldAabb),
    { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] },
  );
  const triangles = colliders.reduce((n, c) => n + c.triangles, 0);

  const manifest = {
    kind: "prop-collision-colliders",
    version: 1,
    scope: {
      visibleMeshApproximation: true,
      retailCollision: false,
      collisionSurfaceUsedAsCollider: false,
      gameClaim: false,
      statement:
        "Static colliders derived from the visible E1 prop meshes near the measured 310 m course. " +
        "This is a visible-geometry approximation, not retail collision data, and it proves nothing beyond this PoC slice.",
    },
    carEnvelope: CAR_ENVELOPE,
    region: {
      method: "shortest distance from the collider footprint hull to the measured course polyline",
      distanceM: opts.regionDistance,
    },
    classification: {
      textureCensus: textureCensusRows,
      unclassifiedTextures: unclassifiedRows,
      unclassifiedColliders: colliders.filter((c) => c.classification === "unclassified").length,
      unclassifiedComponentsInRegion:
        colliders.filter((c) => c.classification === "unclassified").length +
        excluded.filter((e) => e.classification === "unclassified").length,
      note:
        "A texture census is emitted so an unclassified draw is named, not dropped. No unclassified " +
        "component inside the 30 m region became a collider; the rows above are outside the region.",
    },
    rules: {
      sources: [
        "river.block27.instances-all (22 level draws, 8 source instances, world-baked)",
        "river.track.visual (394 direct draws, 57,133 triangles, world-baked)",
      ],
      excludedSources: [
        "river.collision.surface (hidden physics-only mesh; ground-height reference only)",
        "car body meshes (the player car is not a prop)",
        "road, kerb, terrain, mud, tarmac, grass, pavement and other ground-surface components",
      ],
      excludedMeshes: [
        {
          id: geometry.collisionSurface.id,
          reason: "hidden physics collision surface; sampled for ground height only",
        },
        ...Object.values(geometry.carBodies).map((body) => ({
          id: body.meshId,
          reason: "player car body; excluded from the static prop layer",
        })),
      ],
      inclusion: [
        `texture class in {vehicle, building, structure} OR unclassified that passes the geometry rules`,
        `vertical extent >= ${opts.minVerticalExtent} m`,
        `top > sampled ground + ${opts.flushHeight} m`,
        `bottom < sampled ground + ${opts.overheadClearance} m`,
        `footprint within ${opts.regionDistance} m of the course`,
      ],
      boxFit: {
        level: "oriented box from the source instance matrix; extents from the baked vertices",
        track: "minimum-area rectangle over the component convex hull in XZ; Y from the component extent",
        minimumThicknessM: opts.minColliderThickness,
      },
      thresholds: { ...opts },
    },
    road: {
      source: "_work/drivable-path/path.json",
      lengthM: round6(pathData.course.length),
      samples: course.length,
      // Car envelope used by the drivability test: the measured line, with the
      // documented car rectangle oriented to the local tangent.  This is a
      // test envelope, not a drawn road edge.
      testEnvelope: { length: CAR_ENVELOPE.length, width: CAR_ENVELOPE.width },
      defaultProfileBlockedSamples: 0,
      allVisibleBlockedSamples: blockedSamples.size,
      allVisibleBlockedArcs: blockedArcReport,
      note:
        "The committed course predates prop collision. The default profile excludes the visible " +
        "props that overlap the measured line; the all-visible profile includes them and is blocked " +
        "at the measured arcs above. This is a data conflict, not a resolver result.",
    },
    profiles: {
      roadside: {
        active: true,
        colliders: activeCount,
        description: "all mapped visible props except the ones that overlap the measured course line",
      },
      "all-visible": {
        active: false,
        colliders: colliders.length,
        description: "every mapped visible prop; the measured 310 m line is blocked where the excluded set sits",
      },
    },
    inputs: {
      geometry: {
        path: "_work/e1-drive/geometry.json",
        version: geometry.version,
        sha256: null, // filled by the tool with the exact file bytes
      },
      path: {
        path: "_work/drivable-path/path.json",
        sha256: null,
      },
    },
    counts: {
      colliders: colliders.length,
      active: activeCount,
      inactiveOnMeasuredCourse: onCourseCount,
      levelInstances: colliders.filter((c) => c.source === "level-instance").length,
      activeLevelInstances: colliders.filter((c) => c.source === "level-instance" && c.active).length,
      trackComponents: colliders.filter((c) => c.source === "track-visual").length,
      activeTrackComponents: colliders.filter((c) => c.source === "track-visual" && c.active).length,
      triangles: triangles,
      activeTriangles: colliders.filter((c) => c.active).reduce((n, c) => n + c.triangles, 0),
      byClass: Object.fromEntries([...classCounts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))),
      byClassActive: Object.fromEntries(
        [...new Set(colliders.map((c) => c.classification))]
          .sort()
          .map((k) => [k, colliders.filter((c) => c.classification === k && c.active).length]),
      ),
      byClassInactive: Object.fromEntries(
        [...new Set(colliders.map((c) => c.classification))]
          .sort()
          .map((k) => [k, colliders.filter((c) => c.classification === k && !c.active).length]),
      ),
      excluded: Object.fromEntries([...excludedCounts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))),
      outOfRegionByClass: Object.fromEntries([...outOfRegionCounts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))),
      bounds: bounds.min[0] === Infinity ? null : { min: rv(bounds.min), max: rv(bounds.max) },
      boundsActive: (() => {
        const a = colliders.filter((c) => c.active);
        if (!a.length) return null;
        const b = a.reduce((acc, c) => unionAabb(acc, c.worldAabb), {
          min: [Infinity, Infinity, Infinity],
          max: [-Infinity, -Infinity, -Infinity],
        });
        return { min: rv(b.min), max: rv(b.max) };
      })(),
    },
    unclassified: colliders
      .filter((c) => c.classification === "unclassified")
      .map((c) => ({
        id: c.id,
        source: c.source,
        texture: c.provenance?.texture ?? null,
        drawId: c.provenance?.drawId ?? null,
        reason: c.classificationReason,
        size: c.provenance?.size ?? null,
        distanceToCourse: c.distanceToCourse,
      })),
    onMeasuredCourse: onCourseRows.map((r) => ({
      colliderId: r.colliderId,
      classification: r.classification,
      firstArc: round6(r.firstArc),
      lastArc: round6(r.lastArc),
      samples: r.samples,
    })),
    colliders,
    excluded,
  };
  manifest.contentSha256 = sha256(stableStringify(manifest.colliders));
  return manifest;
}

export { stableStringify };
