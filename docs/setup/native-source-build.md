# Native source reference build

The complete **x64 Amax Release source build now passes**. The final process exited
0 and `errsum.py` reports zero compiler/link error lines. That original build was
not run; a later harness-only variant passed the startup/debug-menu smoke checks
recorded below. Nothing was copied over the installed game. Original
`upstream/BlurRebuilt` is clean.

Audit date: 30 October 2026. Base source revision:
`5270304b81983b9e3edbd569ba25235c17bbabd7`, plus the small isolated build fixes below.

## Result and evidence

Writable reference worktree:
`C:/Users/ismailemin/Documents/Blur Web/_work/native-source/Blur1PCDX11`.

| Output | Size | SHA-256 |
| --- | ---: | --- |
| `_work/build/vs64/Release/Amax.exe` | 24,345,088 bytes | `46f7214440d619db80301b948f8cd55a293aa6bb5ab3b0b68c44eadc43bc8d59` |
| `_work/build/vs64/Release/Amax.pdb` | 139,735,040 bytes | `e69c9e8170831c66d6d84692960ce2ac0b50482d93106d5115104b4c84f07067` |

PE inspection confirms AMD64 `0x8664` and PE32+ `0x20b`. `dumpbin /dependents`
shows D3D11/DXGI/D3DCompiler, DirectSound and the VC++ runtime; no D3D9, OpenAL or
Bink DLL import is present. This verifies build/link outputs, not runtime behavior.

Complete evidence in ROOT `_work/build/engine-reference/`:

- `native-build-evidence.json`: output hashes, PE type, zero errors, unchanged
  authored collision function body, original checkout status.
- `amax-x64-linkfix-result.json`: actual final exit 0, elapsed 6.9 seconds for the
  incremental final pass, MSBuild project parallelism 1 and MSVC parallelism 8.
- `openssl-build-result.json`, `openssl-library-evidence.json`.
- `native-reference.patch`: isolated CMake and two source-file fixes, excluding
  phase documentation.

Logs inside the isolated worktree:

- `_work/build/amax-x64.log`: first full build, initially stopped at missing ATL.
  It also records **1,254/1,254 FX11 effect variants** and **693/693 DX11 built-in
  shaders** compiled, zero failures in either stage.
- `_work/build/amax-x64-atl.log`: resumed build reached link; four missing inline
  definitions were then exposed.
- `_work/build/amax-x64-linkfix.log`: final passing build.
- `_work/build/gen/dx11_builtins/report.json`: 693 succeeded, total 693, no failures.
- `_work/build/amax-dependents.txt`: import inspection without executing the game.

The generated `fx11/effects` tree contains `effects.index`, `effects.samplers`,
`effects.states` and 4,985 `.fxo` files including per-technique outputs. The
worktree is retained with its generated files, logs and EXE/PDB. It is detached,
uncommitted and not a managed Codex attachment. No commit or push was made.

## Toolchain and isolation

- Visual Studio 2022 Build Tools installation version `17.14.37806.7`.
- Compiler MSVC `19.44.35229.0`, tool directory `14.44.35207`.
- Windows SDK / FXC `10.0.26100.0`.
- Bundled Python `3.12.14`; use its real executable rather than the Store alias.
- Jam evaluation: 70 supported targets, 2,260 sources, 76 jamfiles. The upstream
  build reference's older 2,449-source count is stale for this revision.

The managed-worktree API rejected the nested upstream repository as sourceRoot;
its allowed roots were the chat workspace folders. A native Git detached worktree
at the verified source revision was used instead. Its phase context helper
recognizes `Blur1PCDX11`; local task T9000 records ownership and verification.

Generating directly in the original checkout would modify it even when CMake's
`-B` points elsewhere: `cpgen.py` writes headers beside source inputs,
`gen_cmake.py` writes targets/unity/buildstamp files, and DX11 custom commands
write source-side shader headers plus `${BLUR_TOP}/_work` outputs. All generation
and native source fixes therefore stay in the isolated worktree.

## Dependencies restored locally

All packages came from the official origins named by the checked-in release
workflow, or the installed Visual Studio catalog. Archive identity was checked
before extraction/use. Downloads and extracted packages stay below ROOT `_work`;
no global PATH change or machine-wide dependency installation occurred.

| Dependency | Source/version | Verification |
| --- | --- | --- |
| D3DX headers | NuGet Microsoft.DXSDK.D3DX 9.29.952.8 | Workflow-pinned SHA-1 matched; SHA-256 recorded |
| OpenAL SDK headers/import lib | Official OpenAL Soft 1.24.3 binary release | Workflow-pinned SHA-1 matched; SHA-256 recorded |
| JPEG sources | Official IJG jpegsrc.v6b | Workflow-pinned SHA-1 matched; SHA-256 recorded |
| OpenSSL source | Official historical openssl-0.9.8i.tar.gz | Workflow-pinned SHA-1 matched; SHA-256 recorded |
| Perl runtime | Official Strawberry Perl portable 5.42.3.1 | Official release SHA-256 matched |
| ATL | Official Microsoft VS v143 14.44.35208 packages | Every SHA-256 matched the installed VS catalog |

Archive URLs, sizes and digests are recorded in ROOT `_work/vendor_dl/`:
`download-evidence.json`, `extraction-evidence.json`, and `atl-evidence.json`.
Strawberry's expected digest was obtained from its
[official release page](https://strawberryperl.com/); the portable package digest
is `6a081a811781c30aca51dbc036afd93092af91e3297901f02c17043795a10690`.

OpenSSL was built with the existing
`tools/demonware_cmake/build_openssl_x64.cmd`, `VC-WIN64A no-asm`, `/MD`, using a
process-only PATH containing the extracted Perl runtime. No OpenSSL source patch
was needed. The resulting `libeay32.lib` and `ssleay32.lib` contain 496 and 43 COFF
object members respectively, all AMD64. They are at ROOT
`_work/vendor_x64/openssl-x64`. The headers/libs originally shipped inside the
DemonWare tree are x86 and were not substituted for these x64 outputs.

## ATL without elevation

The existing Microsoft setup executable was asked to add
`Microsoft.VisualStudio.Component.VC.ATL` silently. Its log reports exit **5007**:
quiet/passive modification requires an elevated process. The launcher returned
before that logged result, so its immediate PowerShell exit status was not
accepted as proof of installation. No UAC prompt was triggered afterward.

Instead, three unmodified VSIX payloads were downloaded from
`download.visualstudio.microsoft.com`, with their SHA-256 checked against the
installed catalog at
`C:/ProgramData/Microsoft/VisualStudio/Packages/_Instances/e7c716a5/catalog.json`:

| Package | SHA-256 |
| --- | --- |
| Microsoft.VC.14.44.17.14.ATL.Headers.base | `f8d375a254b6cfdbe0e7dc4fe7342d6212052068eb6394070dd932c815adb500` |
| Microsoft.VC.14.44.17.14.ATL.X64.base | `6dd0b7f8079c654db2b8fdaebc74900e8418b5204914a77bde93a5b01ac0998c` |
| Microsoft.VC.14.44.17.14.Props.ATLMFC | `652e4af335ebcd08c599e56a38dab5191ff93e4031eeadb02192f0774f9d8a74` |

The extracted ATL root is:
`C:/Users/ismailemin/Documents/Blur Web/_work/vendor/atl-v143-14.44/Contents/VC/Tools/MSVC/14.44.35207/atlmfc`.

A documented optional `BLUR_LOCAL_ATL_ROOT` cache variable was added only to the
isolated `cmake/overrides.cmake`. It adds that package's include directory to
`framework`, and its architecture-specific library directory to Amax. No fake
ATL declarations, reimplementation, registry changes or source header edits were
used to replace the Microsoft package.

## Reproducible generation/build order

Follow the upstream build reference and release workflow **in the isolated
worktree**:

1. `jamextract.py` writes `_work/build/targets_pc_speed.json`.
2. `cpgen.py` generates all 19 `.cp/.cv/.sp` headers.
3. `shadergen.py` generates the SM3 blob C++ files: 693 successful, zero failed;
   166 variants have no SM2 output, which is reported separately.
4. `luabundle.py` generates 139 Lua scripts, a 400,730-byte C++ bundle.
5. **Run `gen_cmake.py` after shadergen**, so its existence checks include all
   14 generated shader C++ files. Regeneration now matches checked-in
   `cmake/targets.cmake` exactly; no hand edit of that generated file remains.
6. Configure `-A x64` with explicit ROOT `_work/vendor`, JPEG, OpenSSL, local ATL
   and Python paths. The first build keeps `BLUR_BUILD_SHADERS=ON`.
7. Build Amax Release and inspect both process exit status and `errsum.py`.

The compiler/build command uses process environment `_CL_=/MP8` and MSBuild
`-m:1`, limiting native compiler work to eight tasks. In PowerShell, quote colon
arguments such as `'-m:1'` and `'-v:m'`; otherwise argument parsing may split
values. `errsum.py` only counts compiler/link errors, so a zero count alone is
insufficient when MSBuild fails before compilation.

ROOT `tools/check_native_source_build.py` supports read-only audits and optional
CMake configure. It detects the extracted ATL root matching the current MSVC
version and passes it when the isolated override exists:

```powershell
& 'C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe' tools/check_native_source_build.py --source '_work/native-source/Blur1PCDX11' --out-dir '_work/build/engine-reference/current' --configure
```

The audit tool intentionally never builds Amax in a supplied source checkout,
because its build custom commands generate source-side files.

## Source fixes exposed by the complete build

Only two authored source files changed in the isolated checkout, each tagged
`[Blur2PC] T9000`:

- `physics/gravity/source/sdk/SPUScene.cpp` includes the existing `AxisBox.inl`,
  making the two authored inline intersection definitions visible at their call
  sites. Its existing `C_Scene::GenerateCollisionTasks` definition is now
  out-of-line, matching calls from `Scene.cpp`; the entire function body was
  compared with HEAD and is byte-for-byte unchanged.
- `animation/source/pose/EventLogger.cpp` includes the existing `PoseFields.inl`,
  making the authored `C_ScalarField::operator F32` definition visible there.

These repair build linkage/definition visibility without replacing collision,
animation or gameplay algorithms. They belong to the common source mechanism;
no changes or merges were made in the original upstream repository. They should
be reviewed before any eventual upstream contribution.

Release maps to the engine's Speed configuration. MinSizeRel maps to its Master
player build; that configuration and native gameplay/runtime parity were not
verified in this task. The existing installed release remains the user's working
native game, and browser port work remains independent.

## Native startup and debug-menu smoke verification

Existing artifacts were audited on 31 October 2026 UTC (1 November in Istanbul).
The audit launched no new game process. Both prior runs used the isolated phase's
canonical `_work/run/Amax.exe`, its `_work/run/run_script.ps1` and
`tools/game_slot.ps1`. Each returned exit **0** after **8 seconds**, with no slot
wait and no timeout. No Amax/BlurRebuilt process remained at the audit snapshot.

The exact tested executable differs from the original build table above:

| Tested output | Size | SHA-256 |
| --- | ---: | --- |
| `Amax.exe` | 24,345,088 bytes | `e9727929768d1e8e2b41ec6abfa836c413d4cd397e571c8b9ba1129c91a5a254` |
| `Amax.pdb` | 140,087,296 bytes | `983032962babd0366d1de4ec4fa8b304b7206d20951387e9375ce96f32719ee6` |

The build-directory and canonical run-directory EXE/PDB hashes match. Its only
additional authored change is the isolated `CoreSystems.cpp` harness switch:
when automation is active and `BLUR2PC_NO_ARTERY_SERVER` is present, the code
selects the existing `ArteryStartup(false,...)` client-only path. Ordinary game
startup remains unchanged. The private run log confirms developer listener and
discovery are disabled. The separate patch is ROOT
`_work/build/engine-reference/native-runtime-harness.patch`.

Verified scenarios:

- **Startup:** the Lua screen assertion reached `intro/startscreen.lua` after
  1.62 seconds. The explicit `SMOKE_STARTSCREEN_READY` marker, one screenshot and
  scripted quit are present. The JPEG visibly shows the Blur power/start screen.
- **Debug menu:** the start-screen assertion passed after 1.63 seconds. The
  documented Right Ctrl input reached `debug/debugscreen.lua` after a 0.25-second
  wait. The log records `SMOKE_DEBUG_MENU_READY` and resolves the real
  `UK_Brighton_1` route through `GameData`; the script then captures one screenshot
  and quits. It does **not** start a race. The JPEG visibly shows the debug city,
  route and race-launch prompt, with development placeholder shapes.

Captures are 1280×720 on the hardware DX11 path (`warp=0`). The private harness
caps at 60 FPS; the screenshots' FPS overlay and these single startup waits are
not performance benchmarks. The engine files named `.png` actually contain TGA
data; the previously created JPEGs were visually inspected without changing them.

- [Startup capture](../../_work/native-source/Blur1PCDX11/_work/run/scripts/startup/startup.jpg)
- [Debug-menu capture](../../_work/native-source/Blur1PCDX11/_work/run/scripts/debug-menu/debug-menu.jpg)
- Logs/result JSON: the corresponding `scripts/startup/` and `scripts/debug-menu/`
  directories, including each `automation.log`, `smoke.txt` and `run-result.json`.
- Consolidated ROOT evidence: `_work/build/engine-reference/native-runtime-evidence.json`.

Private settings are `_work/run/settings-automation.xml`; private saves are
`_work/run/automation_saves/` (empty at audit). The private working directory
`_work/run/reference-data/` links only `cache`, `levels` and `UI` to the local
game-data copy; its debug settings and runtime logs remain outside that data.

The staging manifest's **5,113 game-data files** retain the same relative paths,
sizes and nanosecond modification times, with no additions/removals. This is a
stat comparison, not a pre/post content hash of all game files. The two player
files explicitly recorded before launch—the user's settings XML and `blursave`—
do have identical pre/post SHA-256 hashes. No broader personal-profile scan was
performed. The original upstream Git status remains clean.

At that startup-only audit, remaining runtime gaps were race loading/completion, driving, physics/collision,
powers, audible output, long-session stability or multiplayer validation. The
private `amax.log` contains three missing legacy `audio/dat` file notices,
unauthenticated-username profile notices and pre-exported showroom `Level.ErrorLog`
warnings. Reaching these two screens does not establish complete visual or native
gameplay parity.

## Native race handoff — artifact audit, 1 November 2026

The existing private race attempts have now been audited without launching the
game again or modifying engine code. Both used the same tested EXE/PDB recorded
above, private settings/save roots, and the developer-listener-disabled harness.
They resolve `UK_Brighton_1` from live GameData and request one car/one lap through
the debug menu's existing `Amax.SetupRace` API. The log identifies vehicle loc ID
`1728551317`, stock style `0`; the Lua comment calling this a BMW is a loc-label
assumption, not proof of the selected game record's internal identity.

| Existing attempt | Verified result | Limit |
| --- | --- | --- |
| `scripts/race-stationary` | `RaceState()=="Racing"` at 10.08s; live `ingame/hud.lua` marker at 10.28s; actual 1280×720 track/car/HUD capture; scripted quit, exit 0, 12s, no timeout | Stationary, short race-load/render test; no lap or stable driving validation |
| `scripts/race-native/attempt-throttle` | Racing state at 10.28s; live HUD at 11.28s; W key-down at 12.28s, then captured breakpoint exception `0x80000003`; exit -2147483645, 17s, no timeout | No successful throttle interval, post-throttle screenshot, race completion or proven cause |

The stationary JPEG was visually inspected: a car on the Brighton waterfront
track, 0 mph, lap 0/1 and HUD are visible. It also contains developer render-stage
warnings. This demonstrates native source race loading and rendering, and does
not establish retail visual fidelity, audible output or performance parity.

The crash's symbolized stack is:

```text
DebugBreak
DynamicEffect::AtomicActiveCache<DynamicEffect::Particle::C_Emitter>::Update
DynamicEffect::Particle::C_ParticleManager::UpdateSuperEmitters
Game::C_GameWorld::Update
```

`Code/Mercury/Library/Graphics/Dynamic/include/Dynamic/Atomic.h` has `Update()`
call `Free(m_Deleted[i])` at line 224. The inlined `Free()` contains the explicit
non-Gold invariant:

```cpp
if (m_ActiveElements <= 0 || pElement->m_VectorPosition == -1)
    DebugBreak();
```

The stack establishes that this particle emitter cache invariant fired. The
preserved `dump-context.json` contains raw CPU registers, not recovered optimized
C++ member values; it does not establish which operand failed, a double free,
a scheduler race, or an input-related cause. W key-down precedes the failure;
that timing alone does not prove W caused it. The original source already marks
this check as an investigation of issue 29790. No assertion was removed or
suppressed. Release maps to Speed; the separate Master/`CFG_GOLD` build excludes
this check but was not tested and would not by itself correct a cache error.

The next native debugging step is to open the preserved dump with the exact
matching EXE/PDB and inspect the inlined `Free()` call, cache counts, deleted-list
element identity and `m_VectorPosition`. If the minidump lacks the required
memory/optimized locals, add bounded diagnostics immediately before the invariant
in the isolated Speed worktree and repeat through the private harness. Preserve
the check and compare with a matched no-input run before attributing causation.
Driving, collision/powers, full-race completion, long sessions, audio output and
multiplayer remain unverified. Browser asset/renderer work can proceed
independently of this native reference failure.

- [Stationary race capture](../../_work/native-source/Blur1PCDX11/_work/run/scripts/race-stationary/race.jpg)
- Crash dump, symbolized stack, script, run-result and logs remain untouched in
  `_work/native-source/Blur1PCDX11/_work/run/scripts/race-native/attempt-throttle/`.
- Consolidated current evidence: `_work/build/engine-reference/native-race-audit.json`.
- Repeatable read-only audit: `_work/build/engine-reference/audit-native-race.py`.

The read-only audit again compared all **5,113 game-data file paths, byte sizes
and nanosecond mtimes** against the pre-run staging baseline: no additions,
removals or changed stats. The explicitly recorded player settings and `blursave`
still match their pre-run SHA-256 hashes, the private save root is empty and the
original upstream checkout is clean. This is a current audit against the saved
baseline, not a whole-data pre/post content hash or a broader profile scan.
