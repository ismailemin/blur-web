// Course minimap: a 2D top-down projection of the committed course polyline.
//
// Every point is a committed `layout.course.samples[]` entry or a committed
// `layout.gates[]` entry. Nothing is invented: no road width, no shortcut, no
// interpolated corner. The polyline is downsampled by a fixed stride purely to
// bound the draw cost; the stride and the resulting point count are reported in
// `stats` so the projection can be checked against the layout.
//
// The module is DOM-only (a 2D canvas) and has no engine, renderer or network
// claim.
export const MINIMAP_SCHEMA = 'e1-drive.minimap/1';

// Bound the per-frame draw cost. 480 segments is well under a frame budget and
// keeps a 8,673-sample course recognisable at 220 px.
const MAX_POINTS = 480;
const PADDING_PX = 10;

const COLOUR = Object.freeze({
  course: '#6fc3e8',
  courseShadow: 'rgba(111, 195, 232, 0.22)',
  start: '#7ee787',
  finish: '#f2d06f',
  checkpoint: '#8ab4f8',
  player: '#ffffff',
  remote: '#ff8a65',
  background: 'rgba(8, 14, 20, 0.82)'
});

function project(x, z, frame) {
  return [
    frame.pad + (x - frame.minX) * frame.scale,
    frame.height - frame.pad - (z - frame.minZ) * frame.scale
  ];
}

/**
 * Build a minimap model for one committed layout.
 *
 * @param {HTMLCanvasElement|null} canvas
 * @param {object} layout the committed layout document (`course.samples`, `gates`)
 * @returns {{update: Function, stats: object}|null} null when the layout has no
 *   usable polyline (the caller keeps the canvas hidden)
 */
export function createMinimap(canvas, layout) {
  if (!canvas || typeof canvas.getContext !== 'function') return null;
  const samples = layout?.course?.samples;
  if (!Array.isArray(samples) || samples.length < 2) return null;

  const stride = Math.max(1, Math.ceil(samples.length / MAX_POINTS));
  const points = [];
  for (let index = 0; index < samples.length; index += stride) {
    const sample = samples[index];
    if (Number.isFinite(sample?.x) && Number.isFinite(sample?.z)) points.push([sample.x, sample.z]);
  }
  const last = samples[samples.length - 1];
  if (Number.isFinite(last?.x) && Number.isFinite(last?.z)) {
    const tail = points[points.length - 1];
    if (!tail || tail[0] !== last.x || tail[1] !== last.z) points.push([last.x, last.z]);
  }
  if (points.length < 2) return null;

  const gates = (layout.gates ?? [])
    .filter((gate) => Number.isFinite(gate?.x) && Number.isFinite(gate?.z))
    .map((gate) => ({ x: gate.x, z: gate.z, kind: gate.kind ?? 'checkpoint' }));

  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of points) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const width = canvas.width;
  const height = canvas.height;
  const spanX = Math.max(maxX - minX, 1e-6);
  const spanZ = Math.max(maxZ - minZ, 1e-6);
  const scale = Math.min(
    (width - PADDING_PX * 2) / spanX,
    (height - PADDING_PX * 2) / spanZ
  );
  const frame = { minX, minZ, scale, pad: PADDING_PX, width, height };

  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const projected = points.map(([x, z]) => project(x, z, frame));
  const projectedGates = gates.map((gate) => ({ ...gate, px: project(gate.x, gate.z, frame) }));

  let headingRad = null;
  let lastPosition = null;

  const stats = {
    schema: MINIMAP_SCHEMA,
    points: projected.length,
    sourceSamples: samples.length,
    stride,
    gates: projectedGates.length,
    width,
    height,
    scalePxPerMetre: Number(scale.toFixed(6)),
    lengthMetres: Number.isFinite(layout?.course?.lengthMetres)
      ? layout.course.lengthMetres : null,
    courseId: layout?.courseId ?? null
  };

  function drawRemote(remote) {
    const [px, py] = project(remote.x, remote.z, frame);
    ctx.beginPath();
    ctx.arc(px, py, 3.2, 0, Math.PI * 2);
    ctx.fillStyle = COLOUR.remote;
    ctx.fill();
  }

  function drawPlayer(position) {
    const [px, py] = project(position[0], position[2], frame);
    // Heading from the last frame's movement: the page has no yaw in `state`,
    // and a still car keeps its last direction rather than a guessed one.
    if (lastPosition) {
      const dx = position[0] - lastPosition[0];
      const dz = position[2] - lastPosition[2];
      if (Math.hypot(dx, dz) > 0.05) headingRad = Math.atan2(-dz, dx);
    }
    lastPosition = [position[0], position[2]];
    const angle = headingRad ?? 0;
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(6, 0);
    ctx.lineTo(-4, 4);
    ctx.lineTo(-4, -4);
    ctx.closePath();
    ctx.fillStyle = COLOUR.player;
    ctx.fill();
    ctx.restore();
  }

  function update({ position, remotes } = {}) {
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = COLOUR.background;
    ctx.fillRect(0, 0, width, height);

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(projected[0][0], projected[0][1]);
    for (let index = 1; index < projected.length; index++) {
      ctx.lineTo(projected[index][0], projected[index][1]);
    }
    ctx.strokeStyle = COLOUR.courseShadow;
    ctx.lineWidth = 6;
    ctx.stroke();
    ctx.strokeStyle = COLOUR.course;
    ctx.lineWidth = 2;
    ctx.stroke();

    for (const gate of projectedGates) {
      ctx.beginPath();
      ctx.arc(gate.px[0], gate.px[1], gate.kind === 'start' ? 4 : 3, 0, Math.PI * 2);
      ctx.fillStyle = gate.kind === 'start' ? COLOUR.start
        : gate.kind === 'finish' ? COLOUR.finish : COLOUR.checkpoint;
      ctx.fill();
    }

    if (Array.isArray(remotes)) {
      for (const remote of remotes) {
        if (Number.isFinite(remote?.x) && Number.isFinite(remote?.z)) drawRemote(remote);
      }
    }
    if (Array.isArray(position) && Number.isFinite(position[0]) && Number.isFinite(position[2])) {
      drawPlayer(position);
    }
  }

  return { update, stats };
}
