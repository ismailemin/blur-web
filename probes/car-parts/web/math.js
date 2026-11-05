// Small column-major matrix helpers adapted from
// probes/e1-drive/web/packet-consumer.js (committed 5 November 2026), which in
// turn is a copy of probes/render-packet/web/packet-consumer.js.
//
// Convention: column-major 16-float arrays, column-vector multiplication,
// right-handed view, WebGPU clip depth 0..1. The packet consumer's own
// `multiply`, `orbitView` and `perspective` are reproduced here so this probe
// can reuse the proven camera maths without editing the committed file.

export function identity() {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

export function translation(x, y, z) {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
}

/** Rotation around the local +X axis (the wheel axle in this asset). */
export function rotationX(angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return new Float32Array([
    1, 0, 0, 0,
    0, c, s, 0,
    0, -s, c, 0,
    0, 0, 0, 1
  ]);
}

/** Column-major a*b, matching WGSL mat4x4f * vec4f. */
export function multiply(a, b) {
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

export function orbitView(target, distance, yaw, pitch) {
  const z = [Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch), Math.cos(pitch) * Math.cos(yaw)];
  const eye = [target[0] + distance * z[0], target[1] + distance * z[1], target[2] + distance * z[2]];
  const normalize = (vector) => {
    const length = Math.hypot(...vector);
    return vector.map((value) => value / length);
  };
  const x = normalize([z[2], 0, -z[0]]);
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const view = new Float32Array([
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1
  ]);
  return { view, eye, direction: z, right: x, up: y };
}

export function perspective(fovY, aspect, near, far) {
  const f = 1 / Math.tan(fovY / 2);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, far / (near - far), -1,
    0, 0, (near * far) / (near - far), 0
  ]);
}
