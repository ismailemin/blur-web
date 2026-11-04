// Rigid transform interpolation for render-packet v1.1 timelines.
//
// Packet v1.1 requires every matrix carried in `updates[]` to be rigid
// (rotation + translation, no scale or shear). That restriction is what makes
// interpolation well defined, so the consumer interpolates translation linearly
// and rotation by quaternion slerp instead of blending 16 numbers and hoping.
//
// `interpolateRigid` returns the exact endpoint matrix at f = 0 and f = 1, so a
// frame rendered at an integer tick is bit-identical to the packet.

/** Column-major 16-float multiply. */
export function multiply16(a, b) {
  const out = new Float32Array(16);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[column * 4 + k];
      out[column * 4 + row] = sum;
    }
  }
  return out;
}

/** True when the upper 3x3 is orthonormal with a positive determinant. */
export function isRigid(matrix, tolerance = 1e-5) {
  if (!Array.isArray(matrix) && !(matrix instanceof Float32Array)) return false;
  if (matrix.length !== 16) return false;
  if (!Array.from(matrix).every(Number.isFinite)) return false;
  if (Math.abs(matrix[3]) > tolerance || Math.abs(matrix[7]) > tolerance || Math.abs(matrix[11]) > tolerance) return false;
  if (Math.abs(matrix[15] - 1) > tolerance) return false;
  const c0 = [matrix[0], matrix[1], matrix[2]];
  const c1 = [matrix[4], matrix[5], matrix[6]];
  const c2 = [matrix[8], matrix[9], matrix[10]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  for (const column of [c0, c1, c2]) if (Math.abs(dot(column, column) - 1) > tolerance) return false;
  if (Math.abs(dot(c0, c1)) > tolerance || Math.abs(dot(c0, c2)) > tolerance || Math.abs(dot(c1, c2)) > tolerance) return false;
  const determinant =
    c0[0] * (c1[1] * c2[2] - c1[2] * c2[1]) -
    c1[0] * (c0[1] * c2[2] - c0[2] * c2[1]) +
    c2[0] * (c0[1] * c1[2] - c0[2] * c1[1]);
  return determinant > 0;
}

/** Split a rigid column-major matrix into translation and a unit quaternion (x,y,z,w). */
export function decomposeRigid(matrix) {
  const t = [matrix[12], matrix[13], matrix[14]];
  const m00 = matrix[0], m01 = matrix[4], m02 = matrix[8];
  const m10 = matrix[1], m11 = matrix[5], m12 = matrix[9];
  const m20 = matrix[2], m21 = matrix[6], m22 = matrix[10];
  const trace = m00 + m11 + m22;
  let x, y, z, w;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    w = 0.25 * s;
    x = (m21 - m12) / s;
    y = (m02 - m20) / s;
    z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (m21 - m12) / s;
    x = 0.25 * s;
    y = (m01 + m10) / s;
    z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (m02 - m20) / s;
    x = (m01 + m10) / s;
    y = 0.25 * s;
    z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (m10 - m01) / s;
    x = (m02 + m20) / s;
    y = (m12 + m21) / s;
    z = 0.25 * s;
  }
  const length = Math.hypot(x, y, z, w) || 1;
  return { t, q: [x / length, y / length, z / length, w / length] };
}

/** Shortest-arc spherical interpolation between two unit quaternions. */
export function slerp(a, b, f) {
  let [bx, by, bz, bw] = b;
  let cosine = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (cosine < 0) {
    bx = -bx; by = -by; bz = -bz; bw = -bw;
    cosine = -cosine;
  }
  if (cosine > 0.9995) {
    const x = a[0] + (bx - a[0]) * f;
    const y = a[1] + (by - a[1]) * f;
    const z = a[2] + (bz - a[2]) * f;
    const w = a[3] + (bw - a[3]) * f;
    const length = Math.hypot(x, y, z, w) || 1;
    return [x / length, y / length, z / length, w / length];
  }
  const theta = Math.acos(Math.min(1, cosine));
  const sinTheta = Math.sin(theta);
  const wa = Math.sin((1 - f) * theta) / sinTheta;
  const wb = Math.sin(f * theta) / sinTheta;
  return [a[0] * wa + bx * wb, a[1] * wa + by * wb, a[2] * wa + bz * wb, a[3] * wa + bw * wb];
}

/** Rebuild a rigid column-major matrix from translation and a quaternion. */
export function composeRigid(t, q) {
  const [x, y, z, w] = q;
  const xx = x * x, yy = y * y, zz = z * z;
  const xy = x * y, xz = x * z, yz = y * z;
  const wx = w * x, wy = w * y, wz = w * z;
  return new Float32Array([
    1 - 2 * (yy + zz), 2 * (xy + wz), 2 * (xz - wy), 0,
    2 * (xy - wz), 1 - 2 * (xx + zz), 2 * (yz + wx), 0,
    2 * (xz + wy), 2 * (yz - wx), 1 - 2 * (xx + yy), 0,
    t[0], t[1], t[2], 1
  ]);
}

/**
 * Interpolate two rigid matrices. f = 0 and f = 1 return the inputs unchanged,
 * so integer ticks reproduce the packet byte for byte.
 */
export function interpolateRigid(a, b, f) {
  if (!(f > 0)) return a instanceof Float32Array ? a : Float32Array.from(a);
  if (f >= 1) return b instanceof Float32Array ? b : Float32Array.from(b);
  const from = decomposeRigid(a);
  const to = decomposeRigid(b);
  const q = slerp(from.q, to.q, f);
  const t = [
    from.t[0] + (to.t[0] - from.t[0]) * f,
    from.t[1] + (to.t[1] - from.t[1]) * f,
    from.t[2] + (to.t[2] - from.t[2]) * f
  ];
  return composeRigid(t, q);
}

/**
 * FNV-1a over the raw float32 bits of a matrix list. Used as a cheap,
 * dependency-free checksum of "what transforms were actually submitted".
 */
export function matrixChecksum(matrices) {
  let hash = 0x811c9dc5;
  const scratch = new DataView(new ArrayBuffer(4));
  for (const matrix of matrices) {
    for (let index = 0; index < 16; index++) {
      scratch.setFloat32(0, matrix[index], true);
      const bits = scratch.getUint32(0, true);
      for (let shift = 0; shift < 32; shift += 8) {
        hash ^= (bits >>> shift) & 0xff;
        hash = Math.imul(hash, 0x01000193) >>> 0;
      }
    }
  }
  return '0x' + hash.toString(16).padStart(8, '0');
}
