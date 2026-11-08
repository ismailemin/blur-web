# Robustness — malformed input, typed rejection and fuzz coverage

**Scope:** every input the browser page reads is treated as untrusted. The goal is
not "it never crashes"; it is "a bad input produces a typed, named failure with
an evidence path, and never a silent fallback or a guessed value".

Harness: `probes/robustness/` (`run.mjs`, `cases.mjs`, `fuzz.mjs`, `lib/`).
Verifier: `probes/robustness/verify.mjs`.

## 1. Input inventory

The verifier requires a case for each of these inputs:

| input | reader | failure class |
| --- | --- | --- |
| `index.html` + app modules | page boot | missing module, wrong MIME |
| wasm module | `loadEngine` | bad magic, truncated, wrong export |
| roster | `cars.js` | wrong kind, missing car, bad count |
| car fields | `geometry-chunks.js` | byte length, sha256, first line |
| `Level.levelphysics` | `app.js` | magic, truncation |
| `spawn.json` | `app.js` | missing pose |
| chunk index / level / base / car chunk | `geometry-chunks.js` | truncated, wrong hash, wrong schema |
| map package | `map-package.js` | missing spawn, hash mismatch |
| sprint layout | `sprint-layout.js` | gate order, closure |
| ghost index / ghost record | `ghost-replay.js` | bad base64, wrong tick rate |
| packet v1.1 | `packet-consumer.js` | schema, missing field |
| room-server messages | `net-mvp/client.mjs` | unknown type, bad payload |
| `localStorage` | `sprint-best.js` | corrupt JSON, wrong shape |
| collision manifest | `prop-collision/lib/resolver.mjs` | schema, bad OBB |
| power-up manifest | `powerups.js`, content-db | missing entities, wrong hash |

## 2. Failure taxonomy

Every finding is classified as exactly one of:

- `rejected-typed` — the contract threw an error carrying a stable code
  (`CHUNK_LEVEL_BYTES`, `CHUNK_LEVEL_SHA256`, `MAP_PACKAGE_HASH`, …).
- `rejected-untyped` — the contract threw, but without a stable code. Recorded
  honestly; the recommended validation is to add a code, never to pretend it is
  typed.
- `silent-fallback` — the contract produced a value from bad input. This is the
  only class that fails the gate.
- `accepted` — the input was valid for that case.
- `unsupported` — the case cannot be exercised (missing artifact); carries the
  reason and is not counted as detected.

## 3. Reproducible seeds

The fuzzer is deterministic: `baseSeed = 0x5eed1a7e`, and each case seed is
`(baseSeed + imul(counter + 1, 0x9e3779b1)) >>> 0`. There is no `Math.random`
and no wall clock, so a reported seed reproduces the same document and the same
outcome. The fuzzer runs **2,048** cases per pass (the `2048` seed base count),
with a replica check every 61st case. Two passes must produce identical hashes;
`run.mjs` writes `hashA`/`hashB` and the verifier asserts they match.

To reproduce one case:

```powershell
node probes/robustness/run.mjs --seed 0x5eed1a7e
node probes/robustness/verify.mjs
```

## 4. Recommended validations

- Keep every new reader behind a typed error with a code; add a case in
  `cases.mjs` in the same change.
- When a schema changes, update the inventory in `verify.mjs` and the case in
  the same commit; a stale inventory is a gate failure, not a warning.
- Never accept a struct whose position type is outside the documented set; a
  wider accept would silently change geometry (see `probes/instances`).
- For network messages, reject unknown types with a protocol error and log the
  raw type; never coerce to a known type.

## 5. Limits

- The fuzzer covers the browser input schemas, not the retail binary formats;
  those are covered by the per-reader probes.
- A case marked `unsupported` is not evidence of safety. The gate requires at
  least 80% of findings to carry an evidence citation and every expected-reject
  group to have a detected case.
- The harness runs in Node against the same modules the page imports; it does
  not replace the browser E2E suite (`probes/e2e`).
