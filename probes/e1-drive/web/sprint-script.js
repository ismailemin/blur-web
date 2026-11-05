// Deterministic sprint drivers for the E1 drive slice.
//
// The normal sprint input is trivial: full throttle is requested every tick and
// the rules gate it to zero during the countdown and to brake after the finish.
// The rules never write to the engine; the page and the verifier send the
// returned four floats to `e1_set_input` exactly like the legacy drive script.
//
// A second, diagnostic driver exists to exercise the respawn path on the real
// engine: it waits out the countdown, accelerates straight, then holds full
// steering until the car leaves the measured gate corridor. The verifier uses it
// to prove that the rules respawn the car at the last checkpoint; the page can
// run it with `?sprintfall=1`.

import { COUNTDOWN_TICKS } from './sprint-layout.js';

/** Longest scripted sprint run: 10 s, enough for the slowest roster car + brake. */
export const SPRINT_SCRIPT_TICKS = 600;

/** Packet diagnostics label for a sprint timeline (the legacy drive keeps its own). */
export const SPRINT_PACKET_SCRIPT =
  'sprint: 3-2-1 countdown (1.5 s), throttle while running, brake after the finish ' +
  '(probes/e1-drive/web/sprint-script.js)';

/** What the sprint driver asks for while running. */
export const SPRINT_DESIRED_INPUT = Object.freeze([1, 0, 0, 0]);

/**
 * Input for the normal scripted sprint: the rules gate the request, so the
 * sequence is still a pure function of the rules state and the tick sequence.
 */
export function sprintScriptInput(rules) {
  return rules.gateInput(SPRINT_DESIRED_INPUT);
}

/**
 * Diagnostic off-course driver (respawn test). Tick-based, never wall-clock:
 *   ticks 1..90     countdown, no input
 *   ticks 91..180   throttle straight
 *   ticks 181..420  throttle + full steer (leaves the gate corridor)
 *   ticks 421..600  coast
 */
export const RESPAWN_SCENARIO = Object.freeze({
  holdTicks: COUNTDOWN_TICKS,
  straightTicks: 90,
  steerTicks: 240,
  steer: 1,
  totalTicks: 600
});

export function respawnScriptInput(tick) {
  if (tick <= RESPAWN_SCENARIO.holdTicks) return [0, 0, 0, 0];
  if (tick <= RESPAWN_SCENARIO.holdTicks + RESPAWN_SCENARIO.straightTicks) return [1, 0, 0, 0];
  if (tick <= RESPAWN_SCENARIO.holdTicks + RESPAWN_SCENARIO.straightTicks + RESPAWN_SCENARIO.steerTicks) {
    return [1, 0, RESPAWN_SCENARIO.steer, 0];
  }
  return [0, 0, 0, 0];
}
