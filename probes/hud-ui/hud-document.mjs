/**
 * Blur Web — committed runtime HUD document (`blur.hud-doc/1`).
 *
 * This is the only source of static strings for `runtime-hud.mjs`. Every label
 * either points at a recovered retail loc key (`HUD_*`) or is explicitly marked
 * as a project constant with the reason it could not be recovered.
 *
 * Evidence:
 *  - `_work/hud/raw/gamedata_xt_loc_hud.loc`  (OLTX, English table)
 *  - `_work/hud/hud_objects_dump.txt`         (XT record 189, hud_objects)
 *
 * The loc hashes are recorded so a later change can be diffed against the
 * exact bytes this document was built from. This file contains no pixels, no
 * track geometry and no simulation values.
 */

export const HUD_DOCUMENT_SCHEMA = 'blur.hud-doc/1';

const LOC_SHA256 = 'eae904f04dcc8ae32478160470dbdc629dd45c2cb4a7a67cc726b3a4f3d629e4';
const OBJECTS_SHA256 = '1c16a48be3d9e7bd137a38667e62166e6e0d566bc0ffcb5fd151af0364d48b82';

function retail(key, text) {
  return Object.freeze({ text, key, source: 'retail-loc' });
}

function project(text, reason) {
  return Object.freeze({ text, source: 'project-constant', reason });
}

function placeholder(text) {
  return Object.freeze({ text, source: 'placeholder' });
}

function powerup(label, glyph) {
  return Object.freeze({
    label,
    glyph,
    source: 'project-constant',
    reason: 'probes/e1-drive/web/powerups.js POWERUP_SLICE_LABELS; hud.loc has no generic power-up name table'
  });
}

function feedEvent(key, text) {
  return Object.freeze({ text, key, source: 'retail-loc' });
}

export const HUD_DOCUMENT = Object.freeze({
  schema: HUD_DOCUMENT_SCHEMA,
  source: Object.freeze({
    loc: Object.freeze({ path: '_work/hud/raw/gamedata_xt_loc_hud.loc', sha256: LOC_SHA256 }),
    objects: Object.freeze({ path: '_work/hud/hud_objects_dump.txt', sha256: OBJECTS_SHA256 }),
    record: 'hud_objects (XT record 189)'
  }),

  labels: Object.freeze({
    rootAria: project('race HUD, display only', 'accessibility label carried over from probes/hud-ui/hud.mjs'),
    position: retail('HUD_POS', 'Position'),
    lap: retail('HUD_LAP', 'Laps'),
    time: retail('HUD_TIME', 'TIME'),
    best: retail('HUD_BEST', 'Best'),
    speedUnit: Object.freeze({
      text: 'MPH',
      key: 'HUD_SPEED_MPH',
      source: 'retail-key',
      reason: 'hud_objects Map_SpeedNumber uses HUD_0_SPEED_MPH; the loc value is the integer format %d, so the unit is taken from the key name'
    }),
    gear: project('GEAR', 'hud.loc has no gear label and hud_objects has no gear text node'),
    powerup: project('Power-up', 'hud.loc has no generic power-up slot label; HUD_PT_* are per-effect event strings'),
    health: retail('HUD_HEALTH', 'HEALTH'),
    shield: retail('HUD_ENERGY', 'SHIELD'),
    feed: project('Events', 'hud.loc has no feed heading; HUD_PT_* are the individual event strings'),
    missing: placeholder('—'),
    unknownGlyph: placeholder('?'),
    emptyGlyph: placeholder('·')
  }),

  /** Display labels for the power-up slot. Values are project constants. */
  powerups: Object.freeze({
    Bomb: powerup('MINE', 'M'),
    Shield: powerup('SHIELD', 'S'),
    Repair: powerup('REPAIR', 'R'),
    Nitrous: powerup('NITRO', 'N'),
    Shock: powerup('SHOCK', 'K'),
    Blindfire: powerup('BLINDFIRE', 'B'),
    Shunt: powerup('SHUNT', 'T'),
    Barge: powerup('BARGE', 'G'),
    SuperShield: powerup('SUPERSHIELD', 'X')
  }),

  feed: Object.freeze({
    limit: 8,
    events: Object.freeze({
      barged: feedEvent('HUD_PT_BARGED', 'Barged'),
      bolted: feedEvent('HUD_PT_BOLTED', 'Bolted'),
      bombed: feedEvent('HUD_PT_BOMBED', 'Mined'),
      flashed: feedEvent('HUD_PT_FLASHED', 'Flashed'),
      ghosted: feedEvent('HUD_PT_GHOSTED', 'Ghosted'),
      grabbed: feedEvent('HUD_PT_GRABBED', 'Grabbed'),
      nitroed: feedEvent('HUD_PT_NITROED', 'Nitroed'),
      pulsed: feedEvent('HUD_PT_PULSED', 'Pulsed'),
      repaired: feedEvent('HUD_PT_REPAIRED', 'Repaired'),
      rifted: feedEvent('HUD_PT_RIFTED', 'Rifted'),
      shielded: feedEvent('HUD_PT_SHIELDED', 'Shielded'),
      shocked: feedEvent('HUD_PT_SHOCKED', 'Shocked'),
      shunted: feedEvent('HUD_PT_SHUNTED', 'Shunted')
    })
  }),

  format: Object.freeze({
    /** m/s -> mph, the retail `HUD_0_SPEED_MPH` readout. */
    speedFactor: 2.2369362920544,
    gearNeutral: 'N',
    gearReverse: 'R',
    chargesPrefix: '×',
    detailSeparator: '·',
    secondsSuffix: 's',
    percentSuffix: '%',
    valueSeparator: '/',
    valueSeparatorSpace: ' '
  })
});
