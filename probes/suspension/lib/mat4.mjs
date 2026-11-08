// Column-major 4x4 helpers for the suspension visualiser.
//
// The layout is the same as the e1-drive packet matrices and WGSL mat4x4f:
// m[column * 4 + row]. It is a deliberate copy of `probes/e1-drive/web/packet-adapter.js`
// (multiplyMat4 / rotationXMatrix / carMatrix) so a transform computed here can be
// compared with a packet matrix element by element.

export function identity() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

/** out = a * b (both column-major). */
export function multiply(a, b) {
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

export function translation(x, y, z) {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
}

/** Rotation about +X by `angle`, identical to e1-drive rotationXMatrix. */
export function rotationX(angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1];
}

/** Right-handed rotation about an arbitrary unit `axis` (Rodrigues), column-major. */
export function rotationAxis(axis, angle) {
  const [x, y, z] = axis;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  const r00 = t * x * x + c;
  const r01 = t * x * y - s * z;
  const r02 = t * x * z + s * y;
  const r10 = t * x * y + s * z;
  const r11 = t * y * y + c;
  const r12 = t * y * z - s * x;
  const r20 = t * x * z - s * y;
  const r21 = t * y * z + s * x;
  const r22 = t * z * z + c;
  // rows -> columns
  return [r00, r10, r20, 0, r01, r11, r21, 0, r02, r12, r22, 0, 0, 0, 0, 1];
}

/** Rigid matrix from the engine's three body axes (columns) and position. */
export function basisMatrix(axisX, axisY, axisZ, position) {
  return [
    axisX[0], axisX[1], axisX[2], 0,
    axisY[0], axisY[1], axisY[2], 0,
    axisZ[0], axisZ[1], axisZ[2], 0,
    position[0], position[1], position[2], 1
  ];
}

/** Matrix columns [x, y, z] with no translation. */
export function rotationFromBasis(x, y, z) {
  return [x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, 0, 0, 0, 1];
}

export function transformPoint(m, p) {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]
  ];
}

export function transformDirection(m, d) {
  return [
    m[0] * d[0] + m[4] * d[1] + m[8] * d[2],
    m[1] * d[0] + m[5] * d[1] + m[9] * d[2],
    m[2] * d[0] + m[6] * d[1] + m[10] * d[2]
  ];
}

export function column(m, index) {
  return [m[index * 4], m[index * 4 + 1], m[index * 4 + 2]];
}

export function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ];
}

export function length(a) {
  return Math.hypot(a[0], a[1], a[2]);
}

export function normalize(a) {
  const n = length(a);
  if (!(n > 0) || !Number.isFinite(n)) return null;
  return [a[0] / n, a[1] / n, a[2] / n];
}

export function determinant3(m) {
  return (
    m[0] * (m[5] * m[10] - m[9] * m[6]) -
    m[4] * (m[1] * m[10] - m[9] * m[2]) +
    m[8] * (m[1] * m[6] - m[5] * m[2])
  );
}

/** max |R^T R - I| over the nine rotation entries. */
export function orthonormalityError(m) {
  const x = column(m, 0);
  const y = column(m, 1);
  const z = column(m, 2);
  let worst = 0;
  const pairs = [[x, x, 1], [y, y, 1], [z, z, 1], [x, y, 0], [x, z, 0], [y, z, 0]];
  for (const [a, b, expected] of pairs) {
    worst = Math.max(worst, Math.abs(dot(a, b) - expected));
  }
  return worst;
}

export function shortestAngle(delta) {
  let value = delta;
  while (value > Math.PI) value -= Math.PI * 2;
  while (value < -Math.PI) value += Math.PI * 2;
  return value;
}

export function headingFromForward(forward) {
  return Math.atan2(forward[0], forward[2]);
}

export function allFinite(values) {
  for (const value of values) if (!Number.isFinite(value)) return false;
  return true;
}
