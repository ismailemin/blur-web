// Camera and transform maths shared by the packet producer and the packet validator.
//
// The browser consumer carries its own copy of the same functions in
// web/packet-consumer.js. Keeping two independent implementations is deliberate:
// the validator rebuilds every per-tick camera from its orbit parameters and
// compares it with the stored matrices, so a drift between the two shows up as a
// gate failure instead of a silently different picture.

export const MATRIX_CONVENTION =
  'column-major 16-float array; column-vector; right-handed view; WebGPU clip depth 0..1';

export const DEG2RAD = Math.PI / 180;

export function identity() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

export function translation(x, y, z) {
  const matrix = identity();
  matrix[12] = x;
  matrix[13] = y;
  matrix[14] = z;
  return matrix;
}

/** Rotation about +Y, column-major, right-handed. */
export function rotationY(angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
}

/** Column-major a*b, matching the shader's mat4x4f * vec4f. */
export function multiply(a, b) {
  const out = new Array(16).fill(0);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[column * 4 + k];
      out[column * 4 + row] = sum;
    }
  }
  return out;
}

export function transformPoint(matrix, point) {
  return [
    point[0] * matrix[0] + point[1] * matrix[4] + point[2] * matrix[8] + matrix[12],
    point[0] * matrix[1] + point[1] * matrix[5] + point[2] * matrix[9] + matrix[13],
    point[0] * matrix[2] + point[1] * matrix[6] + point[2] * matrix[10] + matrix[14]
  ];
}

export const normalize = (vector) => {
  const length = Math.hypot(...vector);
  if (!(length > 0)) throw new Error('cannot normalise a zero-length vector');
  return vector.map((value) => value / length);
};

export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * Right-handed orbit view with the layout packet v1 documents.
 * `yaw`/`pitch` are the direction from the target toward the eye.
 */
export function orbitView(target, distance, yaw, pitch) {
  const z = [Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch), Math.cos(pitch) * Math.cos(yaw)];
  const eye = [target[0] + distance * z[0], target[1] + distance * z[1], target[2] + distance * z[2]];
  const x = normalize([z[2], 0, -z[0]]);
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  const view = [
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1
  ];
  return { view, eye, direction: z, basis: { x, y, z } };
}

/** Perspective projection mapping view depth to WebGPU's 0..1 clip range. */
export function perspective(fovY, aspect, near, far) {
  const f = 1 / Math.tan(fovY / 2);
  return [
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, far / (near - far), -1,
    0, 0, (near * far) / (near - far), 0
  ];
}

/**
 * Rebuild a camera from its declared orbit parameters. Used by the validator to
 * prove the stored matrices really are this orbit and not an arbitrary matrix.
 */
export function cameraFromOrbit({ target, distance, yaw, pitch, near, far, verticalFovRadians, aspect }) {
  const { view, eye } = orbitView(target, distance, yaw, pitch);
  return {
    view,
    projection: perspective(verticalFovRadians, aspect, near, far),
    position: eye
  };
}

/**
 * Smallest orbit distance that keeps every given vertex inside the frustum for
 * the chosen yaw/pitch. Measured from a real target, not from the origin.
 */
export function fitVertexDistance(positionArrays, target, yaw, pitch, fovY, aspect, margin) {
  const z = [Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch), Math.cos(pitch) * Math.cos(yaw)];
  const x = normalize([z[2], 0, -z[0]]);
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  const slopeY = Math.tan(fovY / 2);
  const slopeX = slopeY * aspect;
  let distance = 1e-3;
  for (const positions of positionArrays) {
    for (let index = 0; index < positions.length; index += 3) {
      const vx = positions[index] - target[0];
      const vy = positions[index + 1] - target[1];
      const vz = positions[index + 2] - target[2];
      const depth = x[0] * vx + x[1] * vy + x[2] * vz;
      const up = y[0] * vx + y[1] * vy + y[2] * vz;
      const along = z[0] * vx + z[1] * vy + z[2] * vz;
      distance = Math.max(distance, along + Math.abs(depth) / slopeX, along + Math.abs(up) / slopeY, along + 0.05);
    }
  }
  return distance * margin;
}

/** Apply a matrix to every vertex of a flat xyz array (returns a new Float64Array). */
export function transformPositions(positions, matrix) {
  const out = new Float64Array(positions.length);
  for (let index = 0; index < positions.length; index += 3) {
    const x = positions[index];
    const y = positions[index + 1];
    const z = positions[index + 2];
    out[index] = x * matrix[0] + y * matrix[4] + z * matrix[8] + matrix[12];
    out[index + 1] = x * matrix[1] + y * matrix[5] + z * matrix[9] + matrix[13];
    out[index + 2] = x * matrix[2] + y * matrix[6] + z * matrix[10] + matrix[14];
  }
  return out;
}
