# AGENTS.md — Blur Web operating rules

This file governs work in this repository. Read it before editing anything.

## Start here

1. `docs/handoff/CURRENT.md` — current position, next task, blockers.
2. `docs/handoff/NEXT.md` — ordered task queue and acceptance criteria.
3. `docs/work/tasks/` — the task card you are about to work on.
4. `docs/STATUS.md` — chronological history; read the newest entries.
5. `PLAN.md` — goals, phases and non-negotiable scope.

## Hard rules

- **Do not modify** `upstream/`, `game-data/`, or installed game files. They are
  read-only references. `upstream/` must remain a clean checkout.
- **Do not commit** game data, decrypted fixtures, build outputs, `_work/`,
  `upstream/` or generated WASM.
- **Do not guess** unknown formats, offsets, shader conversions, matrices or
  colours. Report the case as unsupported with the byte position or source
  reason. Recovered values must be traceable to original source or data.
- **No claim without evidence.** "Works" requires a reproducible command and a
  recorded result. Browser/GPU work additionally requires a screenshot and a
  clean console.
- **Preserve scope labels.** Partial readers must keep metadata that states what
  was not applied (`instancesApplied:false`, `partialSceneTraversal:true`, etc.).
- **Never silently fall back.** If a codec, format, material or transform is
  unsupported, fail explicitly or return a documented fallback, not a guess.
- **No secrets.** Do not read or print environment files, credentials, tokens or
  personal configuration. None are needed for this project.

## File ownership and parallelism

- One owner per file at a time. Shared C++ files (`scene_reader.cpp`,
  `scene_reader.h`, `CMakeLists.txt`, web entry points) are owned by the main
  agent unless a task card grants ownership.
- Sub-agents may work only on the files named in their task card. They must not
  commit. The main agent reviews the diff, runs the full suite, and commits.
- Independent tasks may run in parallel only when their file sets are disjoint.
- Use background shells for long builds/servers and log to `_work/logs/`.

## Verification gates

Run the smallest relevant check while developing, then the full gate before
commit:

```powershell
# Portable fixture/diagnostic suite (uses existing native/WASM binaries)
python tools/verify_asset_probe.py --skip-build

# Full native + WASM rebuild and suite
python tools/verify_asset_probe.py

# Native CTest (14 cases, conditional on local fixtures)
ctest --test-dir _work/build/asset-reader-native -C Release --output-on-failure
```

Use the bundled Python:

```text
C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe
```

Additional gates per change:

- Native MSVC `/W4` build must be warning-free.
- Native/WASM JSON and independent Python references must agree.
- Deterministic output: repeat runs produce identical hashes.
- No regression in the 27-step `--skip-build` suite.
- Browser changes: screenshot plus no console errors or warnings.

## Documentation and records

- Handoff/status/task records: **Turkish**.
- Format contracts, architecture and technical verification docs: **English**.
- Every task updates its card, writes a session log under `docs/work/logs/`,
  and updates `docs/handoff/CURRENT.md`.
- `docs/STATUS.md` receives a short milestone entry; details stay in task/log files.
- Do not delete historical documents. Mark them `Superseded` and link the
  replacement.

## Git

- Short-lived task branch: `task/T-XXX-short-name`.
- Commit only after the full verification gate passes.
- Commit messages: English, imperative, scoped, e.g.
  `feat(asset-reader): expose bounded resource texture metadata`.
- Never push unless the user asks. Never rewrite published history.
- Stage only intended files; never `git add -A` while `_work/` has new outputs
  unless `.gitignore` has been verified.

## Definition of done

- [ ] Change matches the task card scope and non-goals.
- [ ] Native `/W4` build clean.
- [ ] Relevant CTest and native/WASM/Python verifier pass.
- [ ] Full `--skip-build` suite has no regression.
- [ ] Browser change visually checked; console clean.
- [ ] Task card, session log and `CURRENT.md` updated.
- [ ] Evidence paths and hashes recorded.
- [ ] Main agent reviewed and committed.
