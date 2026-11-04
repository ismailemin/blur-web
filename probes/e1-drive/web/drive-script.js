// The scripted drive used by both the browser run and the node verifier.
//
// One tick is one fixed 1/60 s step of the engine simulation. Tick 0 is the
// settled state `e1_reset()` leaves the car in, so the 300 scripted ticks below
// are exactly 5 s of driving:
//
//   ticks   1..120  full throttle   (2 s)
//   ticks 121..240  coast           (2 s)
//   ticks 241..300  brake           (1 s)
//
// Inputs are a function of the tick number, never of wall-clock time, so two runs
// at different frame rates execute the same sequence and produce the same state
// hashes. That is what makes the browser screenshots comparable with the node
// packet.

export const TICK_HZ = 60;
export const SCRIPT_TICKS = 300;

export const PHASES = Object.freeze([
  { name: 'throttle', firstTick: 1, lastTick: 120, tickCount: 120, input: [1, 0, 0, 0] },
  { name: 'coast', firstTick: 121, lastTick: 240, tickCount: 120, input: [0, 0, 0, 0] },
  { name: 'brake', firstTick: 241, lastTick: 300, tickCount: 60, input: [0, 1, 0, 0] }
]);

/** Input applied to the step that advances the car from tick-1 to tick. */
export function scriptedInput(tick) {
  for (const phase of PHASES) {
    if (tick >= phase.firstTick && tick <= phase.lastTick) return phase.input.slice();
  }
  return [0, 0, 0, 0];
}

/** Input at a tick, for the HUD. */
export function phaseAt(tick) {
  for (const phase of PHASES) {
    if (tick >= phase.firstTick && tick <= phase.lastTick) return phase.name;
  }
  return 'settled';
}
