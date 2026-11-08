// Car constants for the suspension visualiser.
//
// Source of the numbers (read-only references):
//   geometry.*, tyres.*.radius, suspension.*.casterAngle/camberAngle/toeAngle/
//   movementUp/movementDown, steering.steerLimit/ackerman
//     -> RP_CarDynamics record fields, decoded by the e1-drive field list
//        (`probes/e1-drive/native/e1_drive_lib.cpp` FIELD lines 332-363).
//        The field file is one `key<TAB>big-endian-float32-hex` line per value.
//   wheel group rest translations / bounds
//     -> `_work/car-parts/manifest.json` wheelGroups[].localTransform.translation
//        and localBounds (the committed Corvette part manifest).
//
// Nothing here guesses a value: every constant is read from one of those two
// files. Values that exist in the retail data but are not in either file are
// returned as null and named in `missing` (see docs/work/analysis/suspension-visuals.md).

/** Decode one 8-hex-digit big-endian IEEE-754 float32. */
export function decodeFloat32Hex(hex) {
  if (typeof hex !== 'string' || !/^[0-9a-fA-F]{8}$/.test(hex)) return null;
  const buffer = new ArrayBuffer(4);
  const view = new DataView(buffer);
  view.setUint32(0, Number.parseInt(hex, 16), false);
  const value = view.getFloat32(0, false);
  return Number.isFinite(value) ? value : null;
}

/** Parse a `.fields` file into key -> float (only the eight-hex-digit lines). */
export function parseFields(text) {
  const values = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const key = line.slice(0, tab).trim();
    const value = decodeFloat32Hex(line.slice(tab + 1).trim());
    if (value !== null) values.set(key, value);
  }
  return values;
}

const REQUIRED = [
  'geometry.wheelBase',
  'geometry.trackWidthFront',
  'geometry.trackWidthRear',
  'tyres.frontTyres.radius',
  'tyres.rearTyres.radius',
  'suspension.front.casterAngle',
  'suspension.front.camberAngle',
  'suspension.front.toeAngle',
  'suspension.front.movementUp',
  'suspension.front.movementDown',
  'suspension.rear.casterAngle',
  'suspension.rear.camberAngle',
  'suspension.rear.toeAngle',
  'suspension.rear.movementUp',
  'suspension.rear.movementDown',
  'steering.steerLimit',
  'steering.ackerman'
];

/**
 * Build the visualiser config from a parsed field map.
 * `maxTravelFront/Rear` are retail *game* XT fields (frontWheelMaxTravel /
 * rearWheelMaxTravel in GameVehicleData.h:185-186) that are not part of the
 * RP_CarDynamics field list and are not decoded in this repository, so they
 * stay null (the retail render clamp is then reported, not applied).
 */
export function configFromFields(values, car = {}) {
  const missing = [];
  const get = (key) => {
    if (!values.has(key)) {
      missing.push(key);
      return null;
    }
    return values.get(key);
  };
  const config = {
    car,
    wheelBase: get('geometry.wheelBase'),
    trackWidthFront: get('geometry.trackWidthFront'),
    trackWidthRear: get('geometry.trackWidthRear'),
    tyreRadiusFront: get('tyres.frontTyres.radius'),
    tyreRadiusRear: get('tyres.rearTyres.radius'),
    front: {
      caster: get('suspension.front.casterAngle'),
      camber: get('suspension.front.camberAngle'),
      toe: get('suspension.front.toeAngle'),
      movementUp: get('suspension.front.movementUp'),
      movementDown: get('suspension.front.movementDown')
    },
    rear: {
      caster: get('suspension.rear.casterAngle'),
      camber: get('suspension.rear.camberAngle'),
      toe: get('suspension.rear.toeAngle'),
      movementUp: get('suspension.rear.movementUp'),
      movementDown: get('suspension.rear.movementDown')
    },
    steerLimit: get('steering.steerLimit'),
    ackerman: get('steering.ackerman'),
    // Not in the RP_CarDynamics record (see the doc comment above).
    maxTravelFront: null,
    maxTravelRear: null
  };
  for (const key of REQUIRED) if (!values.has(key) && !missing.includes(key)) missing.push(key);
  if (config.maxTravelFront === null) missing.push('game.frontWheelMaxTravel (GameVehicleData XT; not decoded)');
  if (config.maxTravelRear === null) missing.push('game.rearWheelMaxTravel (GameVehicleData XT; not decoded)');
  return { config, missing };
}

/**
 * Four corner records from the committed wheel manifest.
 * `restLocal` is the wheel group's model-space translation (metres).
 * `bottomLocalY` is the lowest point of the group bounds; the tyre is the
 * lowest member in every Corvette corner, and is used as the visual tyre radius.
 */
export function cornersFromManifest(manifest, expected = ['frontleft', 'frontright', 'backleft', 'backright']) {
  if (!Array.isArray(manifest?.wheelGroups)) throw new Error('manifest has no wheelGroups');
  const byCorner = new Map(manifest.wheelGroups.map((group) => [group.corner, group]));
  const corners = {};
  for (const corner of expected) {
    const group = byCorner.get(corner);
    if (!group) throw new Error('manifest has no wheel group ' + corner);
    const linear = group.localTransform?.linearIdentity;
    if (linear !== true) {
      throw new Error('wheel group ' + corner + ' has a non-identity local rotation; the visual chain assumes identity (see manifest localTransform)');
    }
    const translation = group.localTransform?.translation;
    if (!Array.isArray(translation) || translation.length !== 3) {
      throw new Error('wheel group ' + corner + ' has no local translation');
    }
    const bounds = group.localBounds;
    if (!bounds?.min || !bounds?.max) throw new Error('wheel group ' + corner + ' has no local bounds');
    const members = (group.memberParts ?? []).map((member) => ({
      name: member.name,
      wheelPart: member.wheelPart,
      spins: member.spins === true
    }));
    const ambiguous = (group.ambiguousDraws ?? []).map((draw) => ({
      draw: draw.draw,
      wheelPart: draw.wheelPart,
      candidates: draw.candidates,
      assignment: draw.assignment,
      reason: draw.reason
    }));
    corners[corner] = {
      corner,
      restLocal: [translation[0], translation[1], translation[2]],
      bottomLocalY: bounds.min[1],
      bounds: { min: bounds.min.slice(), max: bounds.max.slice() },
      members,
      ambiguous
    };
  }
  return corners;
}

export const CORNERS = ['frontleft', 'frontright', 'backleft', 'backright'];
export const WHEEL_INDEX_TO_CORNER = ['frontleft', 'frontright', 'backleft', 'backright'];
