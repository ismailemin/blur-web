// Retail HUD mount for the driving page (`?hud=retail`).
//
// The HUD itself is the committed, tested DOM module in `probes/hud-ui`. This
// file only adapts the driving page's state to the HUD's `update(state)` shape
// and keeps the mount out of the way of the debug HUD. It is opt-in: without
// `?hud=retail` the page keeps its existing debug overlay and every capture and
// verifier URL is unchanged.
//
// Nothing here invents a value: a field the page does not have is passed as
// `null` and the HUD renders its explicit `—` placeholder.

import { createHud, HUD_DOCUMENT, HUD_SCHEMA } from '/hud-ui/runtime-hud.mjs';

const MPS_TO_MPH = 2.2369362920544;

function host() {
  let element = document.getElementById('retail-hud');
  if (!element) {
    element = document.createElement('div');
    element.id = 'retail-hud';
    element.setAttribute('aria-label', 'race HUD');
    document.body.appendChild(element);
  }
  return element;
}

/** Load the HUD stylesheet once (project style, not retail art). */
function hudStyles() {
  if (document.querySelector('link[data-hud-style]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/hud-ui/runtime-hud.css';
  link.dataset.hudStyle = '1';
  document.head.appendChild(link);
}

function finite(value) {
  return Number.isFinite(value) ? value : null;
}

/** Map the driving page's state to the HUD's documented update shape. */
export function hudState(state) {
  const sprint = state.sprint ?? null;
  const mp = state.mp ?? null;
  const powerups = state.powerups ?? null;
  const local = powerups?.local ?? null;
  const result = mp?.result ?? null;
  const players = mp?.players ?? mp?.room?.players ?? [];
  const selfId = mp?.you?.id ?? null;
  const selfRow = result?.rows?.find((row) => row.playerId === selfId) ?? null;
  return {
    speedMps: finite(state.speed),
    gear: finite(state.gear),
    position: Number.isInteger(selfRow?.positionNumber) ? selfRow.positionNumber : null,
    fieldSize: players.length || null,
    lap: Number.isInteger(sprint?.laps) ? sprint.laps : null,
    laps: Number.isInteger(sprint?.lapsTotal) ? sprint.lapsTotal : null,
    timeSeconds: finite(sprint?.elapsedSeconds),
    bestLapSeconds: finite(sprint?.bestLapSeconds),
    powerup: local?.item ? {
      type: local.item.type,
      charges: Number.isFinite(local.item.charges) ? local.item.charges : null,
      secondsLeft: finite(local.item.secondsLeft)
    } : null,
    shield: local?.shield ? {
      current: finite(local.shield.current),
      max: finite(local.shield.max),
      secondsLeft: finite(local.shield.secondsLeft)
    } : null,
    health: local?.health ? {
      current: finite(local.health.current),
      max: finite(local.health.max)
    } : null,
    feed: (powerups?.lastEvents ?? []).slice(-4).map((event) => event.text ?? String(event.type ?? ''))
  };
}

/**
 * Mount the retail HUD and return `{ update(state), snapshot(), destroy() }`.
 * The caller drives `update` once per rendered frame.
 */
export function mountRetailHud(options = {}) {
  hudStyles();
  const hud = createHud({
    doc: HUD_DOCUMENT,
    host: options.host ?? host(),
    now: options.now
  });
  return {
    schema: HUD_SCHEMA,
    update: (state) => hud.update(hudState(state)),
    snapshot: () => hud.snapshot(),
    destroy: () => hud.destroy()
  };
}

/** True when the page should show the retail HUD (default) rather than the
 * debug chrome. `?hud=debug` opts out; `?hud=retail` is the explicit form. */
export function retailHudRequested(search = location.search) {
  return new URLSearchParams(search).get('hud') !== 'debug';
}

export { MPS_TO_MPH };
