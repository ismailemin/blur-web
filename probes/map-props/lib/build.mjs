/*
 * build.mjs — derive static prop colliders for a map-slice render package.
 *
 * Input is the COMMITTED render package: `render.json#draws` is the visible
 * opaque draw list, the shared position/index buffers are the uploaded geometry,
 * and the slice collision mesh is used only to sample the ground height.  No
 * draw, vertex, triangle, transform or colour is invented.
 *
 * Derivation rules are the documented P74 V2 rules, restated in the manifest:
 *   - one OBB per vertex-connected component;
 *   - minimum-area XZ rectangle over the component hull (rotating calipers);
 *   - material-independent: a component with real vertical geometry is a
 *     collider even when its texture name matches a terrain pattern; a
 *     terrain-textured component is excluded only when its geometry is ground;
 *   - vertical extent >= 0.25 m, top > ground + 0.20 m (not flush),
 *     bottom < ground + 2.50 m (not overhead);
 *   - a non-overhead obstacle occupies a ground-to-top collision column;
 *   - footprint within 40 m of the measured layout polyline.
 *
 * Diagnostic geometry is NOT collider source: the 405/953 blocked draws
 * (effect decal layer, decoder-size, alpha-rule, runtime albedo) are not part of
 * the visible opaque package, so making them solid would create invisible walls.
 * They are counted and named in `coverage.diagnosticDraws`, never silently used.
 */

import {
  CAR_ENVELOPE,
  classifyTexture,
  isGeometryGround,
  stableStringify,
  sha256,
} from "../../prop-collision/lib/collider-build.mjs";
import { convexHull2D, minAreaRect2D } from "../../prop-collision/lib/geom2d.mjs";
import { createWorld } from "../../prop-collision/lib/resolver.mjs";
import { drawComponents } from "./components.mjs";
import { makeWindowedGround } from "./ground.mjs";
import { buildPathIndex } from "./pathindex.mjs";

export const BUILD_DEFAULTS = Object.freeze({
  regionDistance: 40,
  minVerticalExtent: 0.25,
  minColliderThickness: 0.02,
  overheadClearance: 2.5,
  flushHeight: 0.2,
  groundWindowM: 8,
  groundCellM: 8,
  profileDefault: "roadside",
  profileAll: "all-visible",
});

const round6 = (v) => Math.round(v * 1e6) / 1e6;
const rv = (arr) => arr.map(round6);

// --------------------------------------------------------------------------
// natural terrain scenery (scope exclusion, not an inclusion rule)
// --------------------------------------------------------------------------

/*
 * The prop layer is scoped to visible MAN-MADE structures.  Natural scenery
 * (rock formations, natural barriers, sand, cliffs, vegetation) is terrain: its
 * visible meshes are coarse and a min-area rectangle over a 400 m rock ridge is
 * not a wall.  Those components are named in excluded[] with
 * reason "natural-terrain-scenery"; they are never silently dropped and they
 * are not claimed to be collidable by this layer.  The map's own
 * Level.levelphysics remains the physical ground/terrain collision.
 */
const NATURAL_SCENERY_PATTERNS = [
  /rocks/i, /naturalbarrier/i, /boulder/i, /cliff/i, /volcanicwall/i,
  /desertground/i, /sand/i, /mountain/i, /mountbaked/i, /treeline/i,
  /reed/i, /grass/i, /dirt/i, /mud/i, /gravel/i, /offroad/i,
  /riverbasin/i, /bankwall/i, /cleanslate/i, /terrain/i,
];

export function isNaturalScenery(name) {
  if (!name) return false;
  return NATURAL_SCENERY_PATTERNS.some((re) => re.test(name));
}

/*
 * The committed `classifyTexture()` road/terrain set does not know this map
 * family's road names (`desertroad01_diff`, `rg_tarmac_*`, `airfieldconcrete*`).
 * A texture that names a road/ground surface is classified as terrain here, so
 * the geometry ground test decides whether it is a surface (excluded) or a
 * vertical road-cut wall (kept).  This is a name rule only; no image or colour
 * is inspected.
 */
const MAP_GROUND_PATTERNS = [
  /road/i, /tarmac/i, /asphalt/i, /kerb/i, /pavement/i, /paving/i,
  /sidewalk/i, /airfieldconcrete/i, /runway/i, /concretefloor/i,
  /metalwalkway/i, /carpark/i,
];

export function classifyForMap(name) {
  if (name && MAP_GROUND_PATTERNS.some((re) => re.test(name))) {
    return { kind: "terrain", reason: "texture name matches the map road/ground surface set" };
  }
  return classifyTexture(name);
}

// --------------------------------------------------------------------------
// diagnostic structure class (texture-name grouping, never an inclusion rule)
// --------------------------------------------------------------------------

const STRUCTURE_CLASS_PATTERNS = [
  ["silo-tank", /silo|tank|hopp?er|barrel|storage|elevator/i],
  ["container-vehicle", /container|cargo|crate|trailer|truck|wreck|bus_|_bus|van_|scene_vehicle|vehicle|train(?!depot)|railcar|waggon|wagon/i],
  ["fence-barrier", /fence|railing|guardrail|barrier|railholder|rail_|_rail|rails|handrail|bollard/i],
  ["pole-tower", /pole|pylon|mast|sign|spotlight|lamppost|lightpost|frame|legs|column|pillar|antenna/i],
  ["wall", /wall|kerbwall|stonewall|brickwall|concretewall|parapet|retaining/i],
  [
    "building",
    /building|warehouse|hangar|shed|barn|church|depot|house|factory|shop|store|hotel|garage|palace|stadium|residen|facade|\bb\d+_|roof|window|door|balc|shutter|entrance|glass|towerbuilding|controltower|drilltower|office|apartment|market|station|temple|bank|theatre|cinema|museum/i,
  ],
  ["pipe-structure", /pipe|girder|bridge|gate|crane|metal|steel|concrete|brick|stone|decor|platform|stair|step|structure|rust|wood|scaffold|tower|extractor|plant|mine|derrick/i],
];

/** Diagnostic-only grouping of a texture name; returns {class, reason}. */
export function classifyStructureName(name) {
  if (!name) return { class: "other", reason: "draw has no texture name" };
  for (const [cls, re] of STRUCTURE_CLASS_PATTERNS) {
    if (re.test(name)) return { class: cls, reason: `texture name matches the ${cls} pattern` };
  }
  return { class: "other", reason: "texture name matches no structure-class pattern" };
}

// --------------------------------------------------------------------------
// 2D helpers (measured clearance)
// --------------------------------------------------------------------------

function rectCorners2D(cx, cz, ux, uz, vx, vz, hu, hv) {
  return [
    [cx + ux * hu + vx * hv, cz + uz * hu + vz * hv],
    [cx + ux * hu - vx * hv, cz + uz * hu - vz * hv],
    [cx - ux * hu - vx * hv, cz - uz * hu - vz * hv],
    [cx - ux * hu + vx * hv, cz - uz * hu + vz * hv],
  ];
}

function pointInRect(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], zi = poly[i][1], xj = poly[j][0], zj = poly[j][1];
    if ((zi > p[1]) !== (zj > p[1]) && p[0] < ((xj - xi) * (p[1] - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function segmentDistance2D(a, b, c, d) {
  const ux = b[0] - a[0], uz = b[1] - a[1];
  const vx = d[0] - c[0], vz = d[1] - c[1];
  const wx = a[0] - c[0], wz = a[1] - c[1];
  const a1 = ux * ux + uz * uz;
  const b1 = ux * vx + uz * vz;
  const c1 = vx * vx + vz * vz;
  const d1 = ux * wx + uz * wz;
  const e1 = vx * wx + vz * wz;
  const den = a1 * c1 - b1 * b1;
  let s = 0;
  let t = 0;
  if (den < 1e-12) {
    t = c1 > 1e-12 ? e1 / c1 : 0;
  } else {
    s = (b1 * e1 - c1 * d1) / den;
    t = (a1 * e1 - b1 * d1) / den;
  }
  s = Math.max(0, Math.min(1, s));
  t = Math.max(0, Math.min(1, t));
  const px = a[0] + s * ux, pz = a[1] + s * uz;
  const qx = c[0] + t * vx, qz = c[1] + t * vz;
  return Math.hypot(px - qx, pz - qz);
}

export function rectDistance2D(a, b) {
  for (const p of a) if (pointInRect(p, b)) return 0;
  for (const p of b) if (pointInRect(p, a)) return 0;
  let best = Infinity;
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      const d = segmentDistance2D(a[i], a[(i + 1) % 4], b[j], b[(j + 1) % 4]);
      if (d < best) best = d;
    }
  }
  return best;
}

export function carCorners2D(x, z, yaw, envelope = CAR_ENVELOPE) {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return rectCorners2D(x, z, c, s, -s, c, envelope.length / 2, envelope.width / 2);
}

export function colliderCorners2D(c) {
  const lu = Math.hypot(c.axes[0][0], c.axes[0][2]) || 1;
  const lv = Math.hypot(c.axes[2][0], c.axes[2][2]) || 1;
  return rectCorners2D(
    c.center[0], c.center[2],
    c.axes[0][0] / lu, c.axes[0][2] / lu,
    c.axes[2][0] / lv, c.axes[2][2] / lv,
    c.half[0] * lu, c.half[2] * lv,
  );
}

function unionAabb(a, b) {
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
  };
}

// --------------------------------------------------------------------------
// collider derivation
// --------------------------------------------------------------------------

export function deriveColliders(pkg, options = {}) {
  const opts = { ...BUILD_DEFAULTS, ...options };
  const pathIndex = buildPathIndex(pkg.path);
  const ground = makeWindowedGround(pkg.collisionMesh, opts.groundCellM);
  const colliders = [];
  const excluded = [];
  const outOfRegion = new Map();
  const outOfRegionSource = new Map();
  const textureCensus = new Map();
  const structureCensus = new Map();
  const excludedCounts = new Map();
  const componentStats = {
    componentsTotal: 0,
    componentsInRegion: 0,
    componentsCollider: 0,
    componentsExcluded: 0,
    componentsOutOfRegion: 0,
    drawsTotal: 0,
    drawsInRegion: 0,
    drawsWithCollider: 0,
    trianglesInRegion: 0,
    trianglesCollider: 0,
    verticalStructuresInRegion: 0,
    verticalStructuresWithCollider: 0,
    groundBandVerticalStructuresInRegion: 0,
    groundBandVerticalStructuresWithCollider: 0,
  };
  const verticalStructures = [];
  const passThrough = [];

  const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);

  // Every component is traceable to the shared index buffer.  The byte offset
  // is the start of the containing draw's index range; the component index
  // identifies the vertex-connected component inside that range.  No byte
  // position is invented: it is `firstIndex * 4` from the committed render
  // package (Uint32 indices, 4 bytes each).
  const indexFile = pkg.render.buffers.indices.path;
  const sourceOf = (draw, componentIndex = null) => ({
    package: pkg.meta.packageDir,
    file: indexFile,
    byteOffset: draw.firstIndex * 4,
    byteLength: draw.indexCount * 4,
    indexRange: [draw.firstIndex, draw.firstIndex + draw.indexCount],
    drawId: draw.drawId,
    componentIndex,
  });

  for (const draw of pkg.render.draws) {
    componentStats.drawsTotal += 1;
    const name = (draw.textureName ?? "").trim() || null;
    const cls = classifyForMap(name);
    const scls = classifyStructureName(name);
    // texture census over the whole visible package (draw-level, like P74)
    if (!textureCensus.has(cls.kind)) {
      textureCensus.set(cls.kind, { kind: cls.kind, draws: 0, triangles: 0 });
    }
    const trow = textureCensus.get(cls.kind);
    trow.draws += 1;
    trow.triangles += draw.indexCount / 3;

    let drawUsed = false;
    const comps = drawComponents(pkg.positions, pkg.indices, draw.firstIndex, draw.indexCount);
    for (let ci = 0; ci < comps.length; ci++) {
      const c = comps[ci];
      componentStats.componentsTotal += 1;
      const id = `${pkg.mapKey}.${draw.drawId}.component.${String(ci).padStart(3, "0")}`;
      const size = c.max.map((v, i) => v - c.min[i]);

      // footprint distance: min over the XZ convex-hull vertices
      const hull = convexHull2D(c.xz);
      let hullDist = null;
      for (const p of hull) {
        const d = pathIndex.distance(p[0], p[1]);
        if (d !== null && (hullDist === null || d < hullDist)) hullDist = d;
      }
      if (hullDist === null || hullDist > opts.regionDistance) {
        componentStats.componentsOutOfRegion += 1;
        bump(outOfRegion, cls.kind);
        const row = outOfRegionSource.get(cls.kind) ?? {
          count: 0,
          byteOffsetMin: Infinity,
          byteOffsetMax: -Infinity,
          indexRangeMin: Infinity,
          indexRangeMax: -Infinity,
          draws: new Set(),
        };
        row.count += 1;
        row.byteOffsetMin = Math.min(row.byteOffsetMin, draw.firstIndex * 4);
        row.byteOffsetMax = Math.max(row.byteOffsetMax, (draw.firstIndex + draw.indexCount) * 4);
        row.indexRangeMin = Math.min(row.indexRangeMin, draw.firstIndex);
        row.indexRangeMax = Math.max(row.indexRangeMax, draw.firstIndex + draw.indexCount);
        row.draws.add(draw.drawId);
        outOfRegionSource.set(cls.kind, row);
        continue;
      }
      componentStats.componentsInRegion += 1;
      componentStats.trianglesInRegion += c.triangles;
      if (!drawUsed) {
        componentStats.drawsInRegion += 1;
        drawUsed = true;
      }

      const centerXZ = [(c.min[0] + c.max[0]) / 2, (c.min[2] + c.max[2]) / 2];
      const refIndex = pathIndex.nearestPointIndex(centerXZ[0], centerXZ[1]);
      const refY = refIndex === null ? pkg.layout.spawn.ground : pkg.pathGround[refIndex];
      let g = ground.sample(centerXZ[0], centerXZ[1], refY, opts.groundWindowM);
      let groundSamplePoint = [centerXZ[0], centerXZ[1]];
      if (!g.exact) {
        // A prop centroid can sit over a hole in the collision mesh (e.g. inside
        // a building footprint).  Try the deterministic perimeter points and
        // take the exact in-window hit closest to the layout ground.
        const perimeter = [
          [c.min[0], c.min[2]], [c.max[0], c.min[2]], [c.max[0], c.max[2]], [c.min[0], c.max[2]],
          [centerXZ[0], c.min[2]], [centerXZ[0], c.max[2]],
          [c.min[0], centerXZ[1]], [c.max[0], centerXZ[1]],
        ];
        let best = null;
        for (const p of perimeter) {
          const s = ground.sample(p[0], p[1], refY, opts.groundWindowM);
          if (!s.exact) continue;
          if (best === null || Math.abs(s.offset) < Math.abs(best.s.offset) - 1e-12) best = { s, p };
        }
        if (best) {
          g = { ...best.s, source: "collision-mesh-window-perimeter" };
          groundSamplePoint = best.p;
        }
      }
      const heightAboveGround = c.max[1] - g.y;

      const base = {
        id,
        type: "unsupported",
        source: sourceOf(draw, ci),
        sourceKind: "track-visual",
        drawId: draw.drawId,
        section: draw.section ?? null,
        texture: name,
        classification: cls.kind,
        structureClass: scls.class,
        size: rv(size),
        distanceToPath: round6(hullDist),
      };

      // Independent-of-inclusion structure test, used as the coverage
      // denominator: real vertical faces, the component itself >= 1 m tall,
      // and not flush.
      const isVerticalStructure =
        c.verticalRatio !== null &&
        c.verticalRatio >= 0.5 &&
        size[1] >= 1.0 &&
        c.max[1] - g.y > opts.flushHeight;
      if (isVerticalStructure) componentStats.verticalStructuresInRegion += 1;
      const inGroundBand = isVerticalStructure && c.min[1] - g.y < opts.overheadClearance;
      if (inGroundBand) componentStats.groundBandVerticalStructuresInRegion += 1;
      const reject = (reason, detail) => {
        bump(excludedCounts, reason);
        excluded.push({ ...base, reason, detail });
        componentStats.componentsExcluded += 1;
        if (isVerticalStructure) {
          passThrough.push({
            id,
            reason,
            texture: name,
            classification: cls.kind,
            structureClass: scls.class,
            heightAboveGround: round6(heightAboveGround),
            distanceToPath: round6(hullDist),
            groundBand: inGroundBand,
          });
        }
      };

      // P74 V2 terrain rule: only geometry that is actually ground is excluded.
      if (isNaturalScenery(name)) {
        reject("natural-terrain-scenery",
          `texture "${name}" matches the natural-terrain scenery set; natural terrain is not a prop ` +
          "collider in this layer (it is physical terrain, covered by the map collision)");
        continue;
      }
      if (cls.kind === "terrain" || cls.kind === "ground-surface") {
        if (isGeometryGround(c, heightAboveGround)) {
          const reason = cls.kind === "terrain" ? "road-terrain" : "ground-surface";
          reject(reason,
            cls.reason +
            `; geometry ground test: upRatio=${c.upRatio === null ? "null" : c.upRatio.toFixed(3)}` +
            ` verticalRatio=${c.verticalRatio === null ? "null" : c.verticalRatio.toFixed(3)}` +
            ` height=${heightAboveGround.toFixed(3)} m`);
          continue;
        }
      }

      if (size[1] < opts.minVerticalExtent) {
        reject("flat", `vertical extent ${size[1].toFixed(3)} m < ${opts.minVerticalExtent} m`);
        continue;
      }
      if (c.max[1] - g.y <= opts.flushHeight) {
        reject("flush", `top is ${(c.max[1] - g.y).toFixed(3)} m above the sampled ground`);
        continue;
      }
      if (c.min[1] - g.y >= opts.overheadClearance) {
        reject("overhead", `bottom is ${(c.min[1] - g.y).toFixed(3)} m above the sampled ground`);
        continue;
      }

      // A vertical structure that reaches this point becomes a collider.
      if (isVerticalStructure) {
        verticalStructures.push(id);
        if (inGroundBand) componentStats.groundBandVerticalStructuresWithCollider += 1;
      }

      const rect = minAreaRect2D(hull);
      const minHalf = opts.minColliderThickness / 2;
      const inflated = rect.half[0] < minHalf || rect.half[1] < minHalf;
      const collisionBottom = Math.min(c.min[1], g.y);
      const collisionTop = c.max[1];
      const half = [
        Math.max(rect.half[0], minHalf),
        Math.max((collisionTop - collisionBottom) / 2, minHalf),
        Math.max(rect.half[1], minHalf),
      ];
      const center = [rect.center[0], (collisionBottom + collisionTop) / 2, rect.center[1]];
      const axes = [
        [rect.u[0], 0, rect.u[1]],
        [0, 1, 0],
        [rect.v[0], 0, rect.v[1]],
      ];
      const terrainOverride = cls.kind === "terrain" || cls.kind === "ground-surface";
      const collisionClass = terrainOverride ? "structure" : cls.kind;
      const collisionReason = terrainOverride
        ? `${cls.reason}; overridden by geometry: vertical structure ` +
          `(upRatio ${c.upRatio === null ? "null" : c.upRatio.toFixed(3)}, ` +
          `verticalRatio ${c.verticalRatio === null ? "null" : c.verticalRatio.toFixed(3)}, ` +
          `height ${heightAboveGround.toFixed(3)} m above ground)`
        : cls.reason;

      if (!structureCensus.has(scls.class)) {
        structureCensus.set(scls.class, { class: scls.class, components: 0, triangles: 0 });
      }
      const srow = structureCensus.get(scls.class);
      srow.components += 1;
      srow.triangles += c.triangles;

      const record = {
        id,
        type: "obb",
        source: "track-visual",
        center: rv(center),
        axes: axes.map(rv),
        half: rv(half),
        size: rv(half.map((h) => h * 2)),
        worldAabb: (() => {
          const ex = Math.abs(axes[0][0]) * half[0] + Math.abs(axes[2][0]) * half[2];
          const ez = Math.abs(axes[0][2]) * half[0] + Math.abs(axes[2][2]) * half[2];
          return {
            min: rv([center[0] - ex, center[1] - half[1], center[2] - ez]),
            max: rv([center[0] + ex, center[1] + half[1], center[2] + ez]),
          };
        })(),
        vertical: {
          bottom: round6(collisionBottom),
          top: round6(collisionTop),
          height: round6(collisionTop - collisionBottom),
          geometryBottom: round6(c.min[1]),
          geometryTop: round6(c.max[1]),
          groundY: round6(g.y),
          groundExact: g.exact,
          groundHits: g.hits,
          groundSource: g.source,
          groundSamplePoint: rv(groundSamplePoint),
          groundOffsetFromRefM: round6(g.offset),
          bottomAboveGround: round6(collisionBottom - g.y),
          topAboveGround: round6(collisionTop - g.y),
        },
        classification: collisionClass,
        classificationReason: collisionReason,
        structureClass: scls.class,
        structureClassReason: scls.reason,
        distanceToPath: round6(hullDist),
        triangles: c.triangles,
        provenance: {
          package: pkg.meta.packageDir,
          packageLevel: pkg.render.level,
          drawId: draw.drawId,
          section: draw.section ?? null,
          sectionDrawIndex: draw.sectionDrawIndex ?? null,
          texture: name,
          textureId: draw.textureId ?? null,
          textureFormat: draw.textureFormat ?? null,
          drawStatus: draw.status ?? null,
          indexRange: [draw.firstIndex, draw.firstIndex + draw.indexCount],
          indexCount: draw.indexCount,
          componentIndex: ci,
          componentTriangles: c.triangles,
          componentVertexCount: c.vertexCount,
          componentMin: rv(c.min),
          componentMax: rv(c.max),
          boxFit: "minimum-area rectangle over the component convex hull in XZ + vertical extent",
          boxAngleRad: round6(rect.angle),
          minimumThicknessInflated: inflated,
          identityWorld: true,
          textureClassification: cls.kind,
          upRatio: c.upRatio === null ? null : round6(c.upRatio),
          verticalRatio: c.verticalRatio === null ? null : round6(c.verticalRatio),
          slopedRatio: c.slopedRatio === null ? null : round6(c.slopedRatio),
          verticalRule: "non-overhead obstacle: ground-to-top column",
          region: "path-band",
          regionDistanceM: opts.regionDistance,
          groundReference: {
            method: "nearest measured layout point",
            pointIndex: refIndex,
            groundY: round6(refY),
          },
        },
        active: true,
      };
      colliders.push(record);
      componentStats.componentsCollider += 1;
      componentStats.trianglesCollider += c.triangles;
    }
  }
  // drawsWithCollider = number of distinct draws that produced >= 1 collider
  componentStats.drawsWithCollider = new Set(colliders.map((c) => c.provenance.drawId)).size;
  componentStats.verticalStructuresWithCollider = verticalStructures.length;

  return {
    opts,
    pathIndex,
    ground,
    colliders,
    excluded,
    outOfRegion: Object.fromEntries([...outOfRegion.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))),
    outOfRegionSource: Object.fromEntries([...outOfRegionSource.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))),
    excludedCounts: Object.fromEntries([...excludedCounts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))),
    textureCensus: [...textureCensus.values()].sort((a, b) => (a.kind < b.kind ? -1 : 1)),
    structureCensus: [...structureCensus.values()].sort((a, b) => (a.class < b.class ? -1 : 1)),
    componentStats,
    verticalStructureIds: verticalStructures,
    passThrough,
  };
}

// --------------------------------------------------------------------------
// measured-path analysis
// --------------------------------------------------------------------------

export function analyzePath(pkg, pathIndex, ground, colliders, options = {}) {
  const opts = { ...BUILD_DEFAULTS, ...options };
  const envelope = CAR_ENVELOPE;
  const world = createWorld({ colliders, carEnvelope: envelope }, { profile: "all-visible" });
  const onPath = new Map();
  const blocked = new Set();
  const rows = [];
  const n = pkg.path.length;

  // car pose per layout sample: local tangent, recorded ground
  for (let i = 0; i < n; i++) {
    const a = pkg.path[Math.max(0, i - 1)];
    const b = pkg.path[Math.min(n - 1, i + 1)];
    const yaw = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const x = pkg.path[i][0];
    const z = pkg.path[i][1];
    const baseY = pkg.pathGround[i];
    const arc = pathIndex.cumulative[i];
    const hits = world.contactsAll(x, z, yaw, baseY, envelope);
    if (hits.length) blocked.add(i);
    for (const hit of hits) {
      const row = onPath.get(hit.colliderId);
      if (!row) {
        onPath.set(hit.colliderId, {
          colliderId: hit.colliderId,
          classification: hit.classification,
          firstArc: arc,
          lastArc: arc,
          firstSample: i,
          lastSample: i,
          samples: 1,
          maxPenetration: hit.penetration,
        });
      } else {
        row.lastArc = arc;
        row.lastSample = i;
        row.samples += 1;
        if (hit.penetration > row.maxPenetration) row.maxPenetration = hit.penetration;
      }
    }
  }

  const onPathRows = [...onPath.values()]
    .sort((a, b) => (a.colliderId < b.colliderId ? -1 : 1))
    .map((r) => ({
      colliderId: r.colliderId,
      classification: r.classification,
      firstArc: round6(r.firstArc),
      lastArc: round6(r.lastArc),
      firstSample: r.firstSample,
      lastSample: r.lastSample,
      samples: r.samples,
      maxPenetration: round6(r.maxPenetration),
    }));

  // merge overlapping blocked intervals (0.5 m tolerance, same rule as P74)
  const intervals = onPathRows
    .map((r) => ({ firstArc: r.firstArc, lastArc: r.lastArc, colliderId: r.colliderId }))
    .sort((a, b) => (a.firstArc === b.firstArc ? a.lastArc - b.lastArc : a.firstArc - b.firstArc));
  const arcs = [];
  for (const row of intervals) {
    const last = arcs[arcs.length - 1];
    if (last && row.firstArc <= last.lastArc + 0.5) {
      last.lastArc = Math.max(last.lastArc, row.lastArc);
      last.colliderIds.add(row.colliderId);
    } else {
      arcs.push({ firstArc: row.firstArc, lastArc: row.lastArc, colliderIds: new Set([row.colliderId]) });
    }
  }
  const blockedArcs = arcs.map((a) => ({
    arcStart: round6(a.firstArc),
    arcEnd: round6(a.lastArc),
    colliders: a.colliderIds.size,
    colliderIds: [...a.colliderIds].sort(),
  }));

  const blockedSamples = [...blocked].sort((a, b) => a - b);
  return {
    lengthM: round6(pathIndex.lengthM),
    samples: n,
    spacingM: pkg.layout.sampleStepM,
    testEnvelope: { length: envelope.length, width: envelope.width, height: envelope.height },
    blockedSamples: blockedSamples.length,
    blockedSampleIndices: blockedSamples,
    blockedArcs,
    onPathRows,
  };
}

/**
 * Exact 2D clearance between the car pose at every layout sample and the boxes
 * of one resolver profile.  Returns the minimum distance and the collider/arc
 * that produced it.  A zero distance means contact.
 */
export function measureClearance(pkg, pathIndex, colliders, profile) {
  const world = createWorld({ colliders, carEnvelope: CAR_ENVELOPE }, { profile });
  const byId = new Map(colliders.map((c) => [c.id, c]));
  let best = { distance: Infinity, colliderId: null, arc: null, sample: null };
  const r = Math.hypot(CAR_ENVELOPE.length, CAR_ENVELOPE.width) / 2;
  for (let i = 0; i < pkg.path.length; i++) {
    const a = pkg.path[Math.max(0, i - 1)];
    const b = pkg.path[Math.min(pkg.path.length - 1, i + 1)];
    const yaw = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const x = pkg.path[i][0];
    const z = pkg.path[i][1];
    const baseY = pkg.pathGround[i];
    const carTop = baseY + CAR_ENVELOPE.height;
    const carPoly = carCorners2D(x, z, yaw, CAR_ENVELOPE);
    for (const idx of world.queryIndices(x - r, x + r, z - r, z + r)) {
      const col = world.colliders[idx];
      if (col.top <= baseY || col.bottom >= carTop) continue;
      const c = byId.get(col.id);
      if (!c) continue;
      const d = rectDistance2D(carPoly, colliderCorners2D(c));
      if (d < best.distance) {
        best = { distance: d, colliderId: c.id, arc: pathIndex.cumulative[i], sample: i };
      }
    }
  }
  if (!Number.isFinite(best.distance)) {
    best = { distance: null, colliderId: null, arc: null, sample: null };
  }
  return {
    profile,
    minClearanceM: best.distance === null ? null : round6(best.distance),
    colliderId: best.colliderId,
    arcM: best.arc === null ? null : round6(best.arc),
    sample: best.sample,
  };
}

// --------------------------------------------------------------------------
// manifest assembly
// --------------------------------------------------------------------------

/** Count blocked layout samples for a resolver profile (no exclusion logic). */
export function countBlockedSamples(pkg, pathIndex, colliders, profile) {
  const world = createWorld({ colliders, carEnvelope: CAR_ENVELOPE }, { profile });
  const blocked = [];
  for (let i = 0; i < pkg.path.length; i++) {
    const a = pkg.path[Math.max(0, i - 1)];
    const b = pkg.path[Math.min(pkg.path.length - 1, i + 1)];
    const yaw = Math.atan2(b[1] - a[1], b[0] - a[0]);
    if (world.overlaps(pkg.path[i][0], pkg.path[i][1], yaw, pkg.pathGround[i], CAR_ENVELOPE)) {
      blocked.push(i);
    }
  }
  return { profile, blockedSamples: blocked.length, blockedSampleIndices: blocked };
}

export function buildManifest(pkg, options = {}) {
  const opts = { ...BUILD_DEFAULTS, ...options };
  const derived = deriveColliders(pkg, opts);
  const { colliders, excluded } = derived;

  // initially all active; the path pass decides exclusions
  const path = analyzePath(pkg, derived.pathIndex, derived.ground, colliders, opts);

  const onPathById = new Map(path.onPathRows.map((r) => [r.colliderId, r]));
  for (const c of colliders) {
    const row = onPathById.get(c.id);
    c.active = !row;
    if (row) {
      c.exclusion = {
        rule: "on-measured-path",
        reason:
          "the visible collider overlaps the documented car envelope on the measured point-to-point path; " +
          "the path was measured on the collision surface before visible props were colliders, so colliding " +
          "this component would close the only committed line at this arc",
        firstArc: row.firstArc,
        lastArc: row.lastArc,
        samples: row.samples,
        maxPenetration: row.maxPenetration,
      };
    } else {
      delete c.exclusion;
    }
  }

  // Re-hash after active/exclusion is final, then sort.
  for (const c of colliders) {
    const { hash, ...rest } = c;
    c.hash = `sha256:${sha256(stableStringify(rest))}`;
  }
  colliders.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const defaultProfile = countBlockedSamples(pkg, derived.pathIndex, colliders, "roadside");
  const clearance = measureClearance(pkg, derived.pathIndex, colliders, "roadside");

  const active = colliders.filter((c) => c.active);
  const bounds = colliders.reduce(
    (acc, c) => unionAabb(acc, c.worldAabb),
    { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] },
  );
  const boundsActive = active.length
    ? active.reduce((acc, c) => unionAabb(acc, c.worldAabb), {
        min: [Infinity, Infinity, Infinity],
        max: [-Infinity, -Infinity, -Infinity],
      })
    : null;
  const byClass = {};
  for (const c of colliders) byClass[c.classification] = (byClass[c.classification] ?? 0) + 1;
  const byClassActive = {};
  for (const c of active) byClassActive[c.classification] = (byClassActive[c.classification] ?? 0) + 1;
  const byStructureClass = {};
  for (const c of colliders) byStructureClass[c.structureClass] = (byStructureClass[c.structureClass] ?? 0) + 1;

  const blockedArcsFromRows = path.blockedArcs;
  const textCensus = derived.textureCensus.map((row) => {
    const draws = pkg.render.draws.filter((d) => classifyForMap((d.textureName ?? "").trim() || null).kind === row.kind);
    const textures = new Set(draws.map((d) => (d.textureName ?? "").trim() || null).filter(Boolean));
    return { kind: row.kind, draws: row.draws, triangles: row.triangles, distinctTextures: textures.size };
  });

  // ------------------------------------------------------------------
  // typed unsupported records
  //
  // Every case that did not become a collider is named here with the source
  // byte position it came from.  Nothing is guessed and nothing is silently
  // dropped:
  //   - diagnostic draws are not visible opaque geometry;
  //   - in-region components excluded by the documented rules are listed
  //     per component in `excluded[]` (each row is type:"unsupported") and
  //     aggregated here by reason;
  //   - out-of-region components are aggregated by class with the byte range
  //     of the draws that contain them.
  // ------------------------------------------------------------------
  const indexFile = pkg.render.buffers.indices.path;
  const indexBytes = pkg.render.buffers.indices.bytes;
  const unsupported = [];
  for (const d of pkg.diagnostics.draws) {
    unsupported.push({
      type: "unsupported",
      id: `diagnostic.${d.drawId}`,
      reason: "diagnostic-not-visible-opaque",
      detail: `${d.status}: ${d.diagnostic?.reason ?? "not part of the visible opaque draw list"}`,
      source: {
        package: pkg.meta.packageDir,
        file: indexFile,
        byteOffset: d.firstIndex * 4,
        byteLength: d.indexCount * 4,
        indexRange: [d.firstIndex, d.firstIndex + d.indexCount],
        drawId: d.drawId,
        componentIndex: null,
      },
    });
  }
  for (const [reason, count] of Object.entries(derived.excludedCounts)) {
    const rows = excluded.filter((e) => e.reason === reason);
    const byteOffsetMin = Math.min(...rows.map((e) => e.source.byteOffset));
    const byteOffsetMax = Math.max(...rows.map((e) => e.source.byteOffset + e.source.byteLength));
    unsupported.push({
      type: "unsupported",
      id: `excluded.${reason}`,
      reason,
      count,
      detail:
        `${count} in-region components were not turned into a collider; each row in excluded[] ` +
        "is type:\"unsupported\" with its own source byte position",
      source: {
        package: pkg.meta.packageDir,
        file: indexFile,
        byteOffsetMin,
        byteOffsetMax,
        draws: new Set(rows.map((e) => e.source.drawId)).size,
      },
    });
  }
  for (const [cls, row] of Object.entries(derived.outOfRegionSource)) {
    unsupported.push({
      type: "unsupported",
      id: `out-of-region.${cls}`,
      reason: "out-of-region",
      count: row.count,
      detail:
        `${row.count} components of class "${cls}" are farther than ${opts.regionDistance} m from the ` +
        "measured path; they are counted but not extracted into this collider layer",
      source: {
        package: pkg.meta.packageDir,
        file: indexFile,
        byteOffsetMin: row.byteOffsetMin,
        byteOffsetMax: row.byteOffsetMax,
        indexRangeMin: row.indexRangeMin,
        indexRangeMax: row.indexRangeMax,
        draws: row.draws.size,
      },
    });
  }
  unsupported.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const manifest = {
    schema: "blur.map-props/1",
    kind: "map-props-colliders",
    version: 1,
    variant: "map-visible-structures",
    mapKey: pkg.mapKey,
    level: pkg.render.level,
    scope: {
      dataOnly: true,
      visibleMeshApproximation: true,
      retailCollision: false,
      collisionSurfaceUsedAsCollider: false,
      rendererChanged: false,
      e1DriveIntegrated: false,
      gpuUploaded: false,
      browserFrameProduced: false,
      gameClaim: false,
      instancesApplied: false,
      normalsIncluded: false,
      partialSceneTraversal: true,
      coordinateSpace: "source level coordinates, unchanged",
      statement:
        "Static colliders derived from the committed map-slice render package's visible opaque draws. " +
        "This is a visible-geometry approximation, not retail collision data and not Level.levelphysics. " +
        "The slice collision mesh is used only to sample ground height.",
    },
    carEnvelope: CAR_ENVELOPE,
    region: {
      method: "footprint convex-hull vertex within distance of the measured layout polyline",
      distanceM: opts.regionDistance,
      pathSource: `_work/map-slice/${pkg.mapKey}/layout points (render.json#layout)`,
      pathLengthM: round6(pkg.layout.lengthM),
      pathPoints: pkg.layout.pointCount,
      pathSpacingM: pkg.layout.sampleStepM,
      note:
        "Every collider is inside the 40 m band around the measured path. Visible components outside the " +
        "band are counted in counts.outOfRegionByClass and listed in excluded[] only when in-region.",
    },
    rules: {
      sources: [
        `${pkg.meta.packageDir}/render.json#draws (visible opaque draw list)`,
        `${pkg.meta.packageDir}/draws.positions.f32.bin + draws.indices.u32.bin (shared geometry)`,
      ],
      groundSource: {
        path: `${pkg.meta.sliceDir}/${pkg.slice.collision.positions.file} + ${pkg.slice.collision.indices.file}`,
        role: "ground-height reference only; never a collider",
        method:
          `collision-mesh triangle whose Y is closest to the nearest layout-point ground inside ±${opts.groundWindowM} m; ` +
          "falls back to the layout ground with groundExact:false",
      },
      excludedSources: [
        `${pkg.diagnostics.counts.blockedDraws} diagnostic draws (effect decal layer, decoder-size, alpha-rule, runtime albedo) are not visible opaque geometry and are not collider source`,
        "road, kerb, terrain, mud, tarmac, grass and pavement components whose geometry is actually ground (upRatio >= 0.5, or not vertical)",
        "flat components (vertical extent < 0.25 m) and flush components (top <= ground + 0.20 m)",
        "true overhead components (bottom >= ground + 2.50 m)",
        "visible components farther than 40 m from the measured path",
      ],
      inclusion: [
        "one OBB per vertex-connected component of a visible opaque draw",
        "material-independent: a vertical structure is collidable even when its texture name matches a terrain pattern",
        `vertical extent >= ${opts.minVerticalExtent} m`,
        `top > sampled ground + ${opts.flushHeight} m`,
        `bottom < sampled ground + ${opts.overheadClearance} m`,
        "non-overhead obstacles use a ground-to-top collision column",
        `footprint within ${opts.regionDistance} m of the measured path`,
      ],
      boxFit: {
        componentSplit: "vertex-connected triangles; deterministic union-find",
        track: "minimum-area rectangle over the component convex hull in XZ (rotating calipers); Y from the collision column",
        minimumThicknessM: opts.minColliderThickness,
      },
      thresholds: {
        regionDistance: opts.regionDistance,
        minVerticalExtent: opts.minVerticalExtent,
        minColliderThickness: opts.minColliderThickness,
        overheadClearance: opts.overheadClearance,
        flushHeight: opts.flushHeight,
        groundWindowM: opts.groundWindowM,
        groundCellM: opts.groundCellM,
      },
    },
    classification: {
      textureCensus: textCensus,
      unclassifiedTextures: (() => {
        const map = new Map();
        for (const d of pkg.render.draws) {
          const name = (d.textureName ?? "").trim() || "(none)";
          if (classifyForMap(name).kind !== "unclassified") continue;
          if (!map.has(name)) map.set(name, { texture: name, draws: 0, triangles: 0 });
          const row = map.get(name);
          row.draws += 1;
          row.triangles += d.indexCount / 3;
        }
        return [...map.values()].sort((a, b) => (a.texture < b.texture ? -1 : 1));
      })(),
      structureClassCensus: derived.structureCensus,
      structureClassRule:
        "diagnostic texture-name grouping only (building, silo-tank, wall, pole-tower, fence-barrier, " +
        "container-vehicle, pipe-structure, other); it never decides inclusion",
      note:
        "A texture census is emitted so an unclassified draw is named, not dropped. Inclusion is geometry-based, " +
        "so an unclassified vertical structure is still a collider.",
    },
    inputs: {
      render: pkg.files.render,
      diagnostics: pkg.files.diagnostics,
      positions: pkg.files.positions,
      indices: pkg.files.indices,
      layout: pkg.files.layout,
      slice: pkg.files.slice,
      collisionPositions: pkg.files.collisionPositions,
      collisionIndices: pkg.files.collisionIndices,
    },
    path: {
      source: `_work/map-slice/${pkg.mapKey}-render/layout.points.f32.bin`,
      mode: pkg.layout.mode,
      lengthM: round6(pkg.layout.lengthM),
      polylineLengthM: round6(derived.pathIndex.lengthM),
      renderRecordedFloat32LengthM: pkg.render.layout.pointsFloat32?.lengthM ?? null,
      lengthNote:
        "lengthM is the render package's declared layout length. polylineLengthM is the double-precision " +
        "length of the float32 (x,z) points actually used by the clearance test. The render package's own " +
        "pointsFloat32.lengthM is a float32 cumulative sum and is recorded for comparison only.",
      samples: pkg.layout.pointCount,
      spacingM: pkg.layout.sampleStepM,
      spawn: pkg.layout.spawn,
      checkpoints: pkg.layout.checkpoints,
      finish: pkg.layout.finish,
      testEnvelope: path.testEnvelope,
      allVisibleBlockedSamples: path.blockedSamples,
      allVisibleBlockedArcs: blockedArcsFromRows,
      defaultProfileBlockedSamples: defaultProfile.blockedSamples,
      minClearanceM: clearance.minClearanceM,
      minClearanceColliderId: clearance.colliderId,
      minClearanceArcM: clearance.arcM,
      note:
        "The measured point-to-point line predates visible-prop collision. The all-visible profile includes " +
        "every mapped collider and is blocked at the arcs above. The default (roadside) profile marks exactly " +
        "those colliders inactive and is clear by construction; the arcs are recorded, never silently dropped.",
    },
    profiles: {
      roadside: {
        active: true,
        colliders: active.length,
        description:
          "every mapped visible collider except the components that overlap the measured path; the profile " +
          "that keeps the committed line drivable",
      },
      "all-visible": {
        active: false,
        colliders: colliders.length,
        description:
          "every mapped visible collider; the measured path is blocked where the excluded set sits",
      },
    },
    counts: {
      colliders: colliders.length,
      active: active.length,
      inactiveOnMeasuredPath: colliders.length - active.length,
      trackComponents: colliders.filter((c) => c.source === "track-visual").length,
      triangles: colliders.reduce((n, c) => n + c.triangles, 0),
      activeTriangles: active.reduce((n, c) => n + c.triangles, 0),
      byClass,
      byClassActive,
      byStructureClass,
      excluded: derived.excludedCounts,
      outOfRegionByClass: derived.outOfRegion,
      unsupported: {
        total: unsupported.length,
        diagnosticDraws: pkg.diagnostics.draws.length,
        excludedComponents: excluded.length,
        outOfRegionComponents: Object.values(derived.outOfRegion).reduce((a, b) => a + b, 0),
      },
      bounds: { min: bounds.min.map(round6), max: bounds.max.map(round6) },
      boundsActive: boundsActive ? { min: boundsActive.min.map(round6), max: boundsActive.max.map(round6) } : null,
    },
    coverage: {
      ...derived.componentStats,
      componentsExcludedByReason: derived.excludedCounts,
      componentsOutOfRegionByClass: derived.outOfRegion,
      passThroughVerticalStructures: derived.passThrough,
      passThroughByReason: derived.passThrough.reduce((acc, row) => {
        acc[row.reason] = (acc[row.reason] ?? 0) + 1;
        return acc;
      }, {}),
      groundBandPassThroughByReason: derived.passThrough.filter((r) => r.groundBand).reduce((acc, row) => {
        acc[row.reason] = (acc[row.reason] ?? 0) + 1;
        return acc;
      }, {}),
      groundBandNote:
        "ground band = the structure's own vertical geometry starts below ground + 2.5 m, i.e. the car " +
        "can reach it. Natural terrain scenery in the ground band is excluded by scope and named in " +
        "passThroughVerticalStructures.",
      passThroughNote:
        "an in-region component that passes the independent vertical-structure test (verticalRatio >= 0.5, " +
        ">= 1 m above ground, not flush) and is still not a collider is listed here with its exclusion " +
        "reason. Natural terrain scenery dominates; it is named, not silently dropped.",
    },
    unclassified: colliders
      .filter((c) => c.classification === "unclassified")
      .map((c) => ({
        id: c.id,
        texture: c.provenance.texture,
        drawId: c.provenance.drawId,
        structureClass: c.structureClass,
        reason: c.classificationReason,
        size: c.provenance.componentMax.map((v, i) => round6(v - c.provenance.componentMin[i])),
        distanceToPath: c.distanceToPath,
      })),
    onMeasuredPath: path.onPathRows,
    colliders,
    excluded,
    unsupported,
    contentSha256: sha256(stableStringify(colliders)),
  };
  return { manifest, derived, path };
}
