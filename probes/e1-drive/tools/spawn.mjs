// Spawn point and heading for the E1 drive slice.
//
// The point is inside the rendered River block27/node253 area (the level draw
// bounds are x −106.65 … −36.65, z 1023.86 … 1076.84) so the car is seen on the
// track that the render packet draws, and the collision mesh under it is proved
// by `e1_ground_probe` before the car is created (the harness refuses to build a
// world without a ground hit, and the probe result is recorded in run.json).
//
// The heading choice is a scenario parameter, not recovered data: the engine's
// local +Z is the car's longitudinal axis, so heading pi/2 points it along +X,
// the long axis of the drawn strip. It is recorded with every capture.
//
//   source: ground probe at this (x,z) returns hit=1, normal ~(0, 1, 0).
export const TICK0_LIMITS = Object.freeze({
  x: -88.0,
  z: 1050.0,
  heading: Math.PI / 2,
  headingReason: 'engine local +Z is the longitudinal axis; pi/2 aims it down the +X long axis of the drawn strip',
  source: 'ground probe + collision mesh scan (probes/e1-drive/tools/verify_e1_drive.mjs records the hit)'
});
