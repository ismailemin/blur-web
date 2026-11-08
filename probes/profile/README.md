# `probes/profile` — versioned local player profile

Standalone profile store for the browser build. No browser globals are touched at
import time; storage and clock are injected.

```js
import { createProfileStore } from './probes/profile/profile.mjs';

let storage = null;
try { storage = window.localStorage; } catch { storage = null; }

const store = createProfileStore({ storage, now: () => Date.now() });
const loaded = store.load();

if (loaded.code === 'future-schema') {
  // Do not save. This build must not overwrite a newer profile.
} else if (loaded.code === 'corrupt-json' || loaded.code === 'invalid-schema') {
  // The damaged bytes are in loaded.backupKey; the store is already reset.
} else if (loaded.code === 'storage-unavailable') {
  // Memory-only; show the "will not survive a reload" warning.
}

store.submitResult({
  map: 'river',
  course: '310m',
  mode: 'sprint',
  car: 'corvette-zr1-stock',
  timeSeconds: 14.65,
  win: true,
  ghost: null
});
```

- Tests: `node probes/profile/tests.mjs` (writes `_work/profile/tests.json`).
- Contract: `probes/profile/contract.json`.
- Analysis: `docs/work/analysis/profile-store.md`.

The module is the single source for the storage key, backup key, schema version,
legacy key list and failure codes; the contract file and tests compare against
those constants.
