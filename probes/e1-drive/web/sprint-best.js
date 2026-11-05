// Best sprint times, persisted in localStorage.
//
// The sprint is per car, so the stored record is a map from car slug to the best
// finish time. Nothing here is needed by the physics or the packet: it is a
// presentation record, and every failure mode (no storage, private mode, quota,
// malformed JSON) degrades to "no best time" instead of throwing into the drive
// loop. The verifier exercises all of those paths with a fake storage.

export const SPRINT_BEST_KEY = 'e1-drive.sprint.best.v1';

const round3 = (value) => Math.round(value * 1000) / 1000;

function emptyRecord() {
  return { kind: 'e1-drive.sprint-best', version: 1, cars: {} };
}

/**
 * @param {{getItem:Function,setItem:Function}|null} storage  localStorage-shaped
 * @param {string} key
 */
export function createBestTimes(storage, key = SPRINT_BEST_KEY) {
  let persistent = Boolean(storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function');
  let lastError = null;

  function read() {
    if (!persistent) return emptyRecord();
    try {
      const raw = storage.getItem(key);
      if (!raw) return emptyRecord();
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.kind !== 'e1-drive.sprint-best' || parsed.version !== 1 ||
          !parsed.cars || typeof parsed.cars !== 'object' || Array.isArray(parsed.cars)) {
        return emptyRecord();
      }
      const cars = {};
      for (const [slug, value] of Object.entries(parsed.cars)) {
        if (value && Number.isFinite(value.seconds) && value.seconds > 0) {
          cars[slug] = {
            seconds: round3(value.seconds),
            car: typeof value.car === 'string' ? value.car : null,
            checkpoints: Number.isInteger(value.checkpoints) ? value.checkpoints : null,
            respawns: Number.isInteger(value.respawns) ? value.respawns : null
          };
        }
      }
      return { kind: 'e1-drive.sprint-best', version: 1, cars };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      return emptyRecord();
    }
  }

  function write(record) {
    if (!persistent) return false;
    try {
      storage.setItem(key, JSON.stringify(record));
      return true;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      persistent = false;
      return false;
    }
  }

  return {
    key,
    get persistent() { return persistent; },
    get lastError() { return lastError; },
    read,
    bestFor(slug) {
      const record = read();
      return record.cars[slug]?.seconds ?? null;
    },
    /**
     * Record a finish. Returns the stored best and whether this run improved it.
     * A run is never worse than "no record" and a slower run never overwrites a
     * faster one.
     */
    submit(slug, result) {
      if (typeof slug !== 'string' || !slug) throw new Error('best time needs a car slug');
      if (!result || !Number.isFinite(result.seconds) || result.seconds <= 0) {
        throw new Error('best time needs a positive finish time');
      }
      const record = read();
      const previous = record.cars[slug]?.seconds ?? null;
      const seconds = round3(result.seconds);
      const improved = previous === null || seconds < previous;
      if (improved) {
        record.cars[slug] = {
          seconds,
          car: result.car ?? null,
          checkpoints: Number.isInteger(result.checkpoints) ? result.checkpoints : null,
          respawns: Number.isInteger(result.respawns) ? result.respawns : null
        };
        write(record);
      }
      return {
        slug,
        seconds,
        previous,
        best: improved ? seconds : previous,
        improved,
        persistent
      };
    }
  };
}
