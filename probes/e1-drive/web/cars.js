// Car roster for the E1 drive slice (browser side).
//
// The roster is produced by `python probes/e1-drive/tools/car_roster.py`, which
// decodes every RP_CarDynamics record from gamedata\xt\racingphysics.bin with
// the T-005d extractor and gates it on the fields the physics needs. This module
// only resolves a roster entry to the field file the page feeds to e1_create,
// so the browser and the node verifier drive the same bytes.
//
// URL contract: `?car=<slug>` selects a roster car; without it the roster's
// recorded default (the T-007 Corvette) is used, so old links keep working.

export const ROSTER_URL = '/_work/e1-drive/cars.json';

/** Load the generated roster document. */
export async function loadRoster(fetchImpl = fetch) {
  const response = await fetchImpl(ROSTER_URL, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error('roster fetch failed: HTTP ' + response.status + ' (' +
      ROSTER_URL + '; run `python probes/e1-drive/tools/car_roster.py`)');
  }
  const roster = await response.json();
  if (roster.kind !== 'e1-drive.car-roster' || !Array.isArray(roster.roster?.cars)) {
    throw new Error('roster document is not an e1-drive.car-roster');
  }
  if (roster.status !== 'PASS') {
    throw new Error('roster status is ' + roster.status + ': ' + (roster.failures ?? []).join('; '));
  }
  return roster;
}

/** Find a roster car by slug; `null`/`undefined` means the roster default. */
export function resolveCar(roster, requested) {
  const cars = roster.roster.cars;
  const slug = requested || roster.roster.default;
  const car = cars.find((entry) => entry.slug === slug || entry.name === slug);
  if (!car) {
    throw new Error('unknown car ' + JSON.stringify(slug) + '; the roster has ' +
      cars.map((entry) => entry.slug).join(', '));
  }
  return car;
}

/** Served URL of a car's decoded field list. */
export function fieldsUrl(car) {
  return '/' + car.fields.path.split('\\').join('/');
}

/** Compact label for the selector / HUD. */
export function carLabel(car) {
  const mass = Math.round(car.values.mass);
  return car.name + ' — ' + car.drivetrain + ', ' + mass + ' kg, ' + car.values.gears + '\u2011speed';
}

/** Identity block recorded in the packet and the page probe. */
export function carIdentity(car) {
  return {
    slug: car.slug,
    name: car.name,
    recordIndex: car.record.index,
    recordId: car.record.id,
    drivetrain: car.drivetrain,
    mass: car.values.mass,
    fieldsSha256: car.fields.sha256
  };
}
