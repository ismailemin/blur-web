// Compose the derived corner transforms from a recorded scenario and report
// the current-vs-derived error at rest, in a corner, under braking and on the
// measured section-join rise.
//
// Usage:
//   node probes/suspension/tools/visualise.mjs [--scenario=turn] [--all]
//        [--out=_work/suspension]
//
// Outputs:
//   _work/suspension/transforms-<scenario>.json   every tick, wheel + caliper matrix
//   _work/suspension/error-table.json             reference frames, per corner
//   stdout                                        the report table
//
// No browser, no rendering: this is the transform contract, not a screenshot.

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { createVisualState, setSettled, advanceSpin, cornerTransforms } from '../lib/transform.mjs';
import { CORNERS } from '../lib/car-config.mjs';

const ROOT = path.resolve('.');
const SCENARIO_DIR = path.join(ROOT, '_work/suspension/scenarios');
const OUT = path.join(ROOT, '_work/suspension');
const TOLERANCE_M = 0.02;

const args = new Map();
for (const arg of process.argv.slice(2)) {
  const match = /^--([^=]+)=(.*)$/.exec(arg);
  if (match) args.set(match[1], match[2]);
  else if (arg.startsWith('--')) args.set(arg.slice(2), 'true');
}

const sha256 = (data) => 'sha256:' + createHash('sha256').update(data).digest('hex');
const deg = (radians) => radians * 180 / Math.PI;

function loadScenario(name) {
  const file = path.join(SCENARIO_DIR, name + '.json');
  const bytes = readFileSync(file);
  const document = JSON.parse(bytes.toString('utf8'));
  return { document, bytes, file };
}

function bodyLocal(body, vector) {
  return [
    vector[0] * body.axisX[0] + vector[1] * body.axisX[1] + vector[2] * body.axisX[2],
    vector[0] * body.axisY[0] + vector[1] * body.axisY[1] + vector[2] * body.axisY[2],
    vector[0] * body.axisZ[0] + vector[1] * body.axisZ[1] + vector[2] * body.axisZ[2]
  ];
}

function yawRate(body) {
  const angular = body.angular ?? body.angularVelocity ?? [0, 0, 0];
  return angular[0] * body.axisY[0] + angular[1] * body.axisY[1] + angular[2] * body.axisY[2];
}

function lateralSpeed(body) {
  const local = bodyLocal(body, body.velocity);
  return local[0];
}

function referenceTicks(document) {
  const ticks = document.ticks;
  const last = ticks[ticks.length - 1].tick;
  if (document.scenario === 'rest') return [{ tick: 0, why: 'settled rest' }];
  if (document.scenario === 'brake') {
    let peak = null;
    for (let i = 1; i < ticks.length; i++) {
      const decel = (ticks[i - 1].body.speed - ticks[i].body.speed) / ticks[i].dt;
      if (!peak || decel > peak.decel) peak = { decel, tick: ticks[i].tick };
    }
    return [
      { tick: peak.tick, why: 'peak braking ' + peak.decel.toFixed(1) + ' m/s^2' },
      { tick: last, why: 'end of braking (largest travel)' }
    ];
  }
  if (document.scenario === 'turn') {
    // The provisional steer is only trustworthy before the front axle slides
    // (|v_lat| <= 1.5 m/s). Pick the strongest such corner, then also keep the
    // limit-corner travel frame where the steer angle is NOT trustworthy but
    // the suspension travel is the visible error.
    let best = null;
    for (const tick of ticks) {
      const slip = Math.abs(lateralSpeed(tick.body));
      if (slip > 1.5) continue;
      const score = Math.abs(tick.steer.frontleft) * Math.abs(yawRate(tick.body));
      if (!best || score > best.score) best = { score, tick: tick.tick };
    }
    let limit = null;
    for (const tick of ticks) {
      if (tick.tick <= 120) continue;
      const travel = tick.wheels.reduce((sum, wheel, index) =>
        sum + Math.abs(wheel.suspension - document.settled.suspension[CORNERS[index]]), 0);
      if (!limit || travel > limit.travel) limit = { travel, tick: tick.tick };
    }
    return [
      { tick: best?.tick ?? 0, why: 'corner entry, |v_lat| <= 1.5 m/s (steer reconstruction usable)' },
      { tick: limit?.tick ?? last, why: 'limit corner, largest travel (steer reconstruction is a counter-steer artefact; travel only)' }
    ];
  }
  if (document.scenario === 'rise') {
    let best = null;
    for (const tick of ticks) {
      if (tick.body.position[0] < -42) continue; // only the section-join approach/crossing
      const travel = tick.wheels.reduce((sum, wheel, index) =>
        sum + Math.abs(wheel.suspension - document.settled.suspension[CORNERS[index]]), 0);
      if (!best || travel > best.travel) best = { travel, tick: tick.tick };
    }
    return [{ tick: best?.tick ?? last, why: 'largest suspension travel on the 6.36 cm section join' }];
  }
  return [{ tick: 0, why: 'first tick' }];
}

function run(document) {
  const state = createVisualState(document.config, document.corners);
  setSettled(state, [], document.settled.suspension);
  const frames = [];
  for (const tick of document.ticks) {
    advanceSpin(state, tick.tick, tick.wheels, tick.dt);
    const frame = cornerTransforms(tick, state, { steerByCorner: tick.steer });
    frames.push(frame);
  }
  return frames;
}

function contactError(centre, probe, radius) {
  if (!probe || probe.hit !== 1) return null;
  return centre[1] - radius - probe.y;
}

function referenceRows(document, frames, references) {
  const byTick = new Map(frames.map((frame) => [frame.tick, frame]));
  const rows = [];
  for (const reference of references) {
    const tick = document.ticks.find((entry) => entry.tick === reference.tick);
    const frame = byTick.get(reference.tick);
    for (const corner of CORNERS) {
      const entry = frame.corners[corner];
      const wheel = tick.wheels[entry.wheelIndex];
      const probe = wheel.probe;
      const currentContact = contactError(entry.currentCentre, probe, entry.tyreRadius);
      const derivedContact = contactError(entry.centre, probe, entry.tyreRadius);
      rows.push({
        scenario: document.scenario,
        tick: reference.tick,
        why: reference.why,
        corner,
        suspensionMm: entry.suspensionDelta * 1000,
        steerDeg: entry.steerDeg,
        steerReliable: Math.abs(lateralSpeed(tick.body)) <= 1.5,
        spinRad: entry.spin,
        centreDeltaM: Math.hypot(
          entry.centre[0] - entry.currentCentre[0],
          entry.centre[1] - entry.currentCentre[1],
          entry.centre[2] - entry.currentCentre[2]
        ),
        verticalDeltaMm: (entry.centre[1] - entry.currentCentre[1]) * 1000,
        headingErrorDeg: deg(entry.headingError),
        currentContactMm: currentContact === null ? null : currentContact * 1000,
        derivedContactMm: derivedContact === null ? null : derivedContact * 1000,
        contactWithinTolerance: derivedContact === null ? null : Math.abs(derivedContact) <= TOLERANCE_M,
        camberDeg: entry.camberDeg,
        onGround: wheel.onGround === 1
      });
    }
  }
  return rows;
}

function writeTransforms(document, frames) {
  const compact = frames.map((frame) => ({
    tick: frame.tick,
    corners: Object.fromEntries(CORNERS.map((corner) => {
      const entry = frame.corners[corner];
      return [corner, {
        wheel: entry.matrix.map((value) => Number(value.toFixed(9))),
        caliper: entry.staticMatrix.map((value) => Number(value.toFixed(9))),
        current: entry.currentMatrix.map((value) => Number(value.toFixed(9)))
      }];
    }))
  }));
  const text = JSON.stringify({ kind: 'blur.suspension.transforms', version: 1, scenario: document.scenario, frames: compact });
  const file = path.join(OUT, 'transforms-' + document.scenario + '.json');
  writeFileSync(file, text);
  return { file, hash: sha256(Buffer.from(text, 'utf8')), bytes: Buffer.byteLength(text) };
}

function formatTable(rows) {
  const lines = [];
  lines.push('scenario tick  corner      susp mm  steer°  dCentre m  dVert mm  headErr°  curCont mm  derCont mm  tol  camber°');
  for (const row of rows) {
    lines.push([
      row.scenario.padEnd(8),
      String(row.tick).padStart(4),
      row.corner.padEnd(11),
      row.suspensionMm.toFixed(1).padStart(8),
      row.steerDeg.toFixed(2).padStart(6),
      row.centreDeltaM.toFixed(4).padStart(10),
      row.verticalDeltaMm.toFixed(1).padStart(9),
      row.headingErrorDeg.toFixed(2).padStart(9),
      (row.currentContactMm === null ? 'n/a' : row.currentContactMm.toFixed(1)).padStart(10),
      (row.derivedContactMm === null ? 'n/a' : row.derivedContactMm.toFixed(1)).padStart(10),
      (row.contactWithinTolerance === null ? 'n/a' : row.contactWithinTolerance ? 'ok' : 'FAIL').padStart(5),
      (row.camberDeg === null ? 'n/a' : row.camberDeg.toFixed(2)).padStart(8)
    ].join(' '));
  }
  return lines.join('\n');
}

function main() {
  const requested = args.get('scenario')
    ? [args.get('scenario')]
    : readdirSync(SCENARIO_DIR).filter((file) => file.endsWith('.json')).map((file) => file.slice(0, -5));
  const summaries = [];
  const allRows = [];
  for (const name of requested) {
    const { document, bytes } = loadScenario(name);
    const frames = run(document);
    const references = referenceTicks(document);
    const rows = referenceRows(document, frames, references);
    const transforms = writeTransforms(document, frames);
    summaries.push({
      scenario: name,
      scenarioSha256: sha256(bytes),
      tickCount: frames.length,
      references,
      transforms
    });
    allRows.push(...rows);
    console.log('\n' + name.toUpperCase() + ' — ' + document.note);
    console.log(formatTable(rows));
    if (rows.some((row) => !row.steerReliable)) {
      console.log('note: rows on a sliding tick (|v_lat| > 1.5 m/s) report the provisional steer angle; ' +
        'treat only their suspension/travel numbers as usable.');
    }
  }
  mkdirSync(OUT, { recursive: true });
  const report = {
    kind: 'blur.suspension.error-table',
    version: 1,
    toleranceM: TOLERANCE_M,
    generatedBy: 'probes/suspension/tools/visualise.mjs',
    summaries,
    rows: allRows
  };
  const text = JSON.stringify(report, null, 1);
  const file = path.join(OUT, 'error-table.json');
  writeFileSync(file, text);
  console.log('\nwrote ' + path.relative(ROOT, file).replaceAll('\\', '/') + '  ' + sha256(Buffer.from(text, 'utf8')));
}

main();
