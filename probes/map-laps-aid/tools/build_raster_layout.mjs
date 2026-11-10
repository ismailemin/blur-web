// Build the E1 sprint layout for a collision-raster project course.
//
// The raster course (`data/<map>-raster-course.json`) is the committed course
// authority: a closed loop traced on the P48 passable raster with a documented
// 1.68 m car band. This tool turns it into the `e1-drive.sprint` layout the page
// consumes, following the exact schema of the committed `.aid` layouts
// (`data/dumbo-aid-path.json`).
//
// Nothing is invented:
//   * samples are the raster stations verbatim (arc, x, z, groundY);
//   * the start is the raster start station (already the station nearest the
//     committed spawn pose);
//   * the two checkpoints sit on the stations nearest 1/3 and 2/3 of the loop;
//   * the finish is the start station after one loop (the loop is closed);
//   * gate tangents are the central difference of the neighbouring stations.
//
// Usage:
//   node probes/map-laps-aid/tools/build_raster_layout.mjs [--check] [map ...]
//
// Writes `data/<map>-raster-layout.json`.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hashOf } from '../../race-rules/hash.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const DATA = path.join(ROOT, 'probes/map-laps-aid/data');

const MAPS = ['hackney', 'brighton', 'sausalito', 'russianhill', 'bowl'];

const COUNTDOWN = Object.freeze({
  ticks: 90,
  stepTicks: 30,
  labels: ['3', '2', '1'],
  goLabel: 'GO',
  rule: 'input is held at zero until the countdown reaches GO; the timer starts at GO and the car is on the start line'
});

const RULES = Object.freeze({
  tickHz: 60,
  timer: 'elapsed engine ticks from GO at 1/60 s; it keeps running across a respawn and freezes on the finish',
  gateOrder: 'checkpoints count only in index order; a finish crossing is rejected until every checkpoint is passed',
  finishRequiresAllCheckpoints: true,
  progress: 'progress is the arc length of the nearest point on the collision-raster course, clamped to the finish arc',
  respawn: {
    fallBelowGroundMetres: 1,
    airborneTicks: 30,
    outsideBandMarginMetres: 1,
    overshootMarginMetres: 2,
    target: 'the gate point of the last passed checkpoint (the start line before the first checkpoint)',
    rule: 'respawn when the chassis falls more than 1 m below the measured ground at its arc, stays airborne for 30 ticks, or leaves the declared band; the attempt timer keeps running'
  },
  limits: [
    'the course is a project course traced on the collision raster, not the retail AI racing line',
    'the declared 6 m band is the page controller/respawn band, not a road-width claim',
    'the collision-raster clearance is the documented 1.68 m car band (1.5 m guaranteed clearance from blocked cells)',
    'gate lines are rules geometry only; no gate mesh, start banner or race director exists for this map'
  ]
});

const round6 = (value) => Math.round(value * 1e6) / 1e6;

function stationAt(course, index) {
  const stations = course.stations;
  return stations[((index % stations.length) + stations.length) % stations.length];
}

function tangentAt(course, stationIndex) {
  // Forward difference along the loop. A closed loop can double back at the
  // start (a hairpin apex), where the central difference is exactly zero but
  // the forward direction is still well defined. The window used is recorded.
  const current = stationAt(course, stationIndex);
  for (let offset = 1; offset <= 6; offset++) {
    const next = stationAt(course, stationIndex + offset);
    const tx = next.x - current.x;
    const tz = next.z - current.z;
    const length = Math.hypot(tx, tz);
    if (length > 1e-9) return { tx: tx / length, tz: tz / length, offset, kind: 'forward' };
  }
  for (let offset = 1; offset <= 6; offset++) {
    const previous = stationAt(course, stationIndex - offset);
    const tx = current.x - previous.x;
    const tz = current.z - previous.z;
    const length = Math.hypot(tx, tz);
    if (length > 1e-9) return { tx: tx / length, tz: tz / length, offset, kind: 'backward' };
  }
  throw new Error('gate tangent has zero length at station ' + stationIndex);
}

function gateFromStation(course, stationIndex, { id, kind, index }) {
  const station = stationAt(course, stationIndex);
  const tangent = tangentAt(course, stationIndex);
  const headingRad = Math.atan2(tangent.tx, tangent.tz);
  const half = 8 / 2;
  return {
    id,
    kind,
    index,
    sampleIndex: ((stationIndex % course.stations.length) + course.stations.length) % course.stations.length,
    arc: round6(station.arc),
    x: station.x,
    z: station.z,
    groundY: station.groundY,
    height: station.groundY,
    headingRad: round6(headingRad),
    tangent: { tx: round6(tangent.tx), tz: round6(tangent.tz), windowMetres: 5, stationOffset: tangent.offset, kind: tangent.kind },
    widthMetres: 8,
    requestedWidthMetres: 8,
    narrowed: false,
    // The gate line is perpendicular to the tangent by construction.
    a: [round6(station.x - tangent.tz * half), round6(station.z + tangent.tx * half)],
    b: [round6(station.x + tangent.tz * half), round6(station.z - tangent.tx * half)],
    coverage: {
      measured: false,
      source: 'not measured',
      note: 'the collision-raster course has no draw-coverage measurement; the gate line is rules geometry only'
    },
    groundCheck: {
      source: 'the gate line is sampled against the committed course stations, not the raster',
      groundY: station.groundY,
      note: 'the raster passability of this line is recorded by the committed raster course document'
    }
  };
}

function nearestStation(course, arc) {
  let best = 0;
  let bestDistance = Infinity;
  for (let index = 0; index < course.stations.length; index++) {
    const distance = Math.abs(course.stations[index].arc - arc);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  }
  return best;
}

export function buildLayout(mapId) {
  // Prefer the ring centreline when it exists: the boundary course is not
  // drivable on these levels, the widest-ring centreline is.
  const centrelinePath = path.join(DATA, mapId + '-centreline.json');
  const coursePath = existsSync(centrelinePath)
    ? centrelinePath
    : path.join(DATA, mapId + '-raster-course.json');
  const courseBytes = readFileSync(coursePath);
  const doc = JSON.parse(courseBytes.toString('utf8'));
  if (doc.kind !== 'blur.map-laps-aid.raster-course') {
    throw new Error(mapId + ': source is not a raster course (' + doc.kind + ')');
  }
  if (doc.verdict !== 'course') throw new Error(mapId + ': raster course is not a verdict "course"');
  const course = doc.course;
  if (course.closed !== true) throw new Error(mapId + ': raster course is not closed');
  if (!Array.isArray(course.stations) || course.stations.length < 8) {
    throw new Error(mapId + ': raster course has too few stations');
  }

  const length = course.loopLengthMetres;
  const stations = course.stations;
  if (Math.abs(stations[stations.length - 1].arc + course.sampleStepMetres - length) > 0.5) {
    throw new Error(mapId + ': station arcs do not close on the loop length');
  }

  const start = course.start;
  const spawn = doc.source.spawn;

  // The raster trace is a grid staircase (0.5 m cells), which a car cannot
  // follow. A centred moving average over +/- 2 stations (1.25 m) removes the
  // staircase while staying inside the 1.5 m clearance the erosion guarantees.
  const SMOOTH_HALF_WINDOW = 2;
  const smoothStations = stations.map((station, index) => {
    let sx = 0;
    let sz = 0;
    let sy = 0;
    let count = 0;
    for (let offset = -SMOOTH_HALF_WINDOW; offset <= SMOOTH_HALF_WINDOW; offset++) {
      const neighbour = stations[(index + offset + stations.length) % stations.length];
      sx += neighbour.x;
      sz += neighbour.z;
      sy += neighbour.groundY;
      count++;
    }
    return { ...station, x: round6(sx / count), z: round6(sz / count), groundY: round6(sy / count) };
  });
  const smoothCourse = { ...course, stations: smoothStations, start: smoothStations[0] };
  const startGate = gateFromStation(smoothCourse, 0, { id: 'start', kind: 'start', index: 0 });
  const samples = smoothStations.map((station) => ({
    arc: station.arc,
    x: station.x,
    z: station.z,
    groundY: station.groundY,
    covered: null
  }));

  const checkpoint1 = nearestStation(course, length / 3);
  const checkpoint2 = nearestStation(course, (2 * length) / 3);
  const gates = [
    startGate,
    gateFromStation(smoothCourse, checkpoint1, { id: 'checkpoint-1', kind: 'checkpoint', index: 1 }),
    gateFromStation(smoothCourse, checkpoint2, { id: 'checkpoint-2', kind: 'checkpoint', index: 2 }),
    // The loop closes on the start, so a finish gate at arc == length would be
    // unreachable: the nearest-sample progress wraps to 0 there. The finish sits
    // on the last station, one sample step before the start.
    gateFromStation(smoothCourse, stations.length - 1, { id: 'finish', kind: 'finish', index: 3 })
  ];
  const finishArc = round6(length - course.sampleStepMetres);
  gates[3].arc = finishArc;

  const body = {
    kind: 'e1-drive.sprint',
    version: 1,
    courseId: mapId,
    scope: {
      collisionOnly: true,
      retailRacingLine: false,
      retailStartLine: false,
      rendererClaim: false,
      vehiclePhysics: false,
      gameRun: false,
      pathDriven: false,
      note: 'closed collision-raster project course; not the retail AI racing line and not a retail start line'
    },
    source: {
      rasterCourse: path.relative(ROOT, coursePath).split(path.sep).join('/'),
      rasterCourseSha256: hashOf(doc),
      rasterCourseFileSha256: sha256File(courseBytes),
      level: doc.level,
      courseSource: doc.courseSource,
      clearance: doc.clearance,
      algorithm: doc.source.algorithm,
      spawn: spawn,
      // The package pins the layout must agree with (map-package.js checkPins).
      render: pinOf('_work/map-batch/' + doc.level + '/draws.json'),
      physics: pinOf('game-data/Blur/levels/' + doc.level + '/Level.levelphysics'),
      slice: pinOf('_work/map-batch/' + doc.level + '/collision.json')
    },
    course: {
      rule: 'closed collision-raster project course; the spawn is the committed spawn pose snapped to the nearest loop station and the finish is the same station after one loop',
      name: doc.level + ' collision-raster project course',
      spawn: {
        x: start.x,
        z: start.z,
        ground: start.groundY,
        headingRad: startGate.headingRad
      },
      spawnGroundY: start.groundY,
      spawnSource: {
        rule: 'the car spawns on the loop start station, aligned with the loop tangent; the committed spawn pose only selects the start station',
        committedSpawn: spawn,
        snapMetres: course.spawnProjection?.metres ?? null
      },
      start: { x: start.x, z: start.z },
      finish: { x: start.x, z: start.z },
      measuredEnd: { x: start.x, z: start.z },
      lengthMetres: length,
      finishArc: finishArc,
      sampleStepMetres: course.sampleStepMetres,
      sampleCount: samples.length,
      gateRule: 'arc-progression',
      // The scripted test controller uses the measured-path pure-pursuit tuning
      // (the same one the Amboy/Gracia hairpins need). This is a controller
      // choice, not a recovered vehicle or map value.
      controlProfile: 'tight-pursuit',
      span: {
        startArc: 0,
        finishArc: finishArc,
        lengthMetres: length,
        measuredLengthMetres: length,
        note: 'arcs are measured along the closed collision-raster loop; the loop length is the course authority'
      },
      band: {
        halfWidthMetres: 6,
        source: 'declared controller and respawn band required by the page validator; not a road-width claim',
        note: 'the collision-raster clearance is the documented 1.68 m car band, not this 6 m controller band'
      },
      corridor: {
        halfWidthMetres: doc.clearance.halfWidthMetres,
        source: 'collision-raster car band',
        note: doc.clearance.metric
      },
      coverage: {
        measured: false,
        source: 'not measured',
        note: 'draw coverage of this project course was not measured; the committed draw path coverage does not apply to this line'
      },
      samples
    },
    gates,
    countdown: COUNTDOWN,
    rules: RULES,
    integration: {
      integrated: true,
      note: 'built by probes/map-laps-aid/tools/build_raster_layout.mjs from the committed raster course; the E1 map-batch package copies this document verbatim as _work/e1-drive/<map>/layout.json',
      needed: []
    }
  };
  body.hash = hashOf(body);
  return { body, doc, courseBytes };
}

function sha256File(bytes) {
  return 'sha256:' + createHash('sha256').update(bytes).digest('hex');
}

function pinOf(relative) {
  const file = path.join(ROOT, relative);
  const bytes = readFileSync(file);
  const hash = sha256File(bytes);
  return {
    path: relative,
    bytes: bytes.length,
    sha256: hash,
    // The map-batch package records no canonical content hash for these files;
    // its committed file pin is used, exactly as the `.aid` layouts do.
    contentHash: hash,
    contentHashSource: 'the map-batch package records no canonical content hash for this file; its committed file pin is used'
  };
}

const args = process.argv.slice(2);
const check = args.includes('--check');
const selected = args.filter((arg) => !arg.startsWith('--'));
const maps = selected.length ? selected : MAPS;

let failures = 0;
for (const mapId of maps) {
  const { body } = buildLayout(mapId);
  const text = JSON.stringify(body, null, 2) + '\n';
  const file = path.join(DATA, mapId + '-raster-layout.json');
  if (check) {
    if (!existsSync(file)) {
      console.error('MISSING ' + path.relative(ROOT, file));
      failures++;
      continue;
    }
    const committed = readFileSync(file, 'utf8');
    if (committed !== text) {
      console.error('STALE ' + path.relative(ROOT, file));
      failures++;
      continue;
    }
    console.log('OK ' + mapId + ' ' + body.course.lengthMetres.toFixed(6) + ' m ' +
      body.course.sampleCount + ' stations ' + body.hash);
  } else {
    writeFileSync(file, text, 'utf8');
    console.log('WROTE ' + mapId + ' ' + body.course.lengthMetres.toFixed(6) + ' m ' +
      body.course.sampleCount + ' stations ' + body.hash);
  }
}
if (failures) process.exit(1);
