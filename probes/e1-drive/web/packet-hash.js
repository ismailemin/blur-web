// Canonical JSON + packet hash, identical to
// probes/render-packet/tools/packet-format.mjs (which is the committed
// definition of "the packet hash"). Duplicated deliberately: the browser cannot
// import a Node tool that uses node:crypto, and the E1 slice must not modify the
// committed probe. tools/verify_e1_drive.mjs checks that both implementations
// agree for every tick of the produced packet.

import { sha256Hex } from './sha256.js';

export const PACKET_KIND = 'blur.render-packet';
export const PACKET_VERSION = 1.1;

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortValue(value[key]);
    return out;
  }
  return value;
}

/** Compact, key-sorted JSON. Numbers use JavaScript's shortest round-trip form. */
export function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

/** sha256 over any value's canonical JSON. `undefined` members are dropped. */
export function hashOf(value) {
  return 'sha256:' + sha256Hex(canonicalJson(value));
}

/** sha256 over the packet body (everything except the `hash` member). */
export function packetHash(packet) {
  const body = { ...packet };
  delete body.hash;
  return hashOf(body);
}
