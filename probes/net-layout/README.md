# T-006b net-layout probe

Measures the C++ struct ABI that the game uses as its **wire format**, on native
MSVC x64 and on wasm32, and measures what the `wchar_t` mitigation
(`-fshort-wchar`) actually fixes.

It is an engine-free probe: no engine header is included, nothing is wired into
the game, and no packet is captured. `src/wire_decls.h` is a *transcription* of
the declarations the game copies into datagrams, with a `file:line` citation per
field; `tests/check_decls.py` re-reads those lines from the committed upstream
tree and fails if the transcription and upstream disagree.

Scope labels: `engineIntegration:false`, `liveCapture:none`,
`gameImplemented:false`, `browserRun:none`.

---

## 1. What it measures

For every type that is `memcpy`-ed into a datagram (`src/probe_core.cpp`):

| measurement | how |
| --- | --- |
| `sizeof`, `alignof` | the compiler |
| field offset | address difference `(char*)&obj.member - (char*)&obj` — valid for the non-standard-layout types where `offsetof` is only conditionally supported; the real `offsetof()` value is emitted too whenever the type *is* standard-layout, so the two can be compared |
| bitfield position | bit-pattern probe: build an all-zero object, set exactly one bitfield to all ones, and record which bits of the object representation changed. Bitfields cannot be `offsetof`-ed and their allocation unit is compiler-defined, so this is the authoritative check |
| padding | the object is constructed twice over `0xCD` and over `0xA5` storage, every field is then assigned the same values, and the bytes that still differ are exactly the bytes nothing wrote. Those bytes travel on the wire but carry no field |
| canonical record | a fixed field assignment, zero-filled storage, whole-object hex + FNV-1a 64 |
| golden fixture | the explicit encoder (`src/wire_encoder.cpp`) emits the native wire bytes; the same field values are encoded natively and on wasm32 and compared byte-for-byte, and the legacy raw struct copy is compared against the same bytes as a negative test |

It also builds **derived records**: the exact byte sequences the P0 packet
writers emit. Those writers are field-by-field (`WriteU8`/`WriteBuffer`), not
struct copies, so their layout is cursor arithmetic over the measured `sizeof` of
the embedded types. Every record names the writer line for each field.

`tests/reference_layout.py` recomputes the same numbers from the declarations
with an independent layout algorithm (no code shared with the C++ probe) for
three target models: `msvc`+`wchar 2`, `itanium`+`wchar 4`, `itanium`+`wchar 2`.
All three C++ outputs are compared against it.

---

## 2. Targets

| label | toolchain | `wchar_t` | notes |
| --- | --- | ---: | --- |
| `native-msvc-x64-wchar2` | MSVC 19.44 x64 Release, `/W4 /permissive-` | 2 | the retail/PC serializer authority. MSVC has no 4-byte `wchar_t`, so "native default" and "native wchar_t 2" are the same build; the probe asserts `sizeof(WCHAR) == sizeof(wchar_t)` |
| `wasm32-default-wchar4` | Emscripten (Clang 24) `-std=c++17 -O2` | 4 | today's wasm ABI — the project's wasm build passes no `-fshort-wchar` |
| `wasm32-short-wchar2` | same + `-fshort-wchar` | 2 | the mitigation under test |

---

## 3. Build and run

Use the bundled Python if `python` is a Store alias:
`C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe`.

One command (declaration gate, native build + CTest, two wasm builds, three
reference models, all comparisons, golden encoder fixtures, determinism,
evidence):

```powershell
python probes/net-layout/tests/run_net_layout.py
```

Reuse existing binaries:

```powershell
python probes/net-layout/tests/run_net_layout.py --skip-build
```

Native only:

```powershell
python probes/net-layout/tests/run_net_layout.py --native-only
```

Manual:

```powershell
$cmake = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe"
& $cmake -S probes/net-layout -B _work/build/net-layout-native -G "Visual Studio 17 2022" -A x64
& $cmake --build _work/build/net-layout-native --config Release
& "_work/build/net-layout-native/Release/net_layout_probe.exe" --selftest
& "_work/build/net-layout-native/Release/net_layout_probe.exe" --out _work/net-layout/native.json

$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"
& $py _work/toolchains/emsdk/upstream/emscripten/em++.py `
  probes/net-layout/src/probe_core.cpp probes/net-layout/src/wire_encoder.cpp `
  probes/net-layout/src/wasm_entry.cpp `
  -std=c++17 -O2 -Wno-invalid-offsetof -Wno-reorder-ctor -fshort-wchar `
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=node,web -sALLOW_MEMORY_GROWTH=0 `
  --no-entry -sEXPORTED_FUNCTIONS=_wire_layout_json,_wire_layout_selftest `
  -sEXPORTED_RUNTIME_METHODS=UTF8ToString `
  -o _work/net-layout/build/net_layout_wasm32-short-wchar2.mjs
node probes/net-layout/tests/verify_net_layout.mjs `
  _work/net-layout/build/net_layout_wasm32-short-wchar2.mjs `
  _work/net-layout/wasm-short-wchar.json

& $py probes/net-layout/tests/reference_layout.py --wchar 2 --abi msvc --out _work/net-layout/reference-msvc-wchar2.json
& $py probes/net-layout/tests/check_decls.py
```

Outputs go to `_work/net-layout/` and `_work/logs/net-layout/` only.

The two clang warnings suppressed in the wasm command are artifacts of copying an
engine header into an engine-free probe, not measurements:
`-Winvalid-offsetof` fires while parsing the `if constexpr`-discarded
`offsetof` branch for non-standard-layout types, and `-Wreorder-ctor` fires
because the upstream constructors initialise in a different order than the
declarations (copied verbatim).

---

## 4. Output

`_work/net-layout/native.json` (and the two wasm variants):

```json
{
  "schema": "blur-wire-layout/1",
  "upstreamCommit": "5270304b81983b9e3edbd569ba25235c17bbabd7",
  "build": { "target": "native", "wcharBytes": 2, "pointerBytes": 8, "boolBytes": 1,
             "enumBytes": 4, "alignofLongLong": 8, "littleEndian": true, "flags": "…" },
  "types": [ { "name": "…", "size": 56, "align": 8, "standardLayout": false,
               "fields": [ { "name": "…", "offset": 0, "size": 8, "count": 1,
                             "offsetof": 0, "source": "SystemProfile.h:76" } ],
               "bitfields": [ { "name": "…", "width": 1, "changedBits": 1,
                                "firstBit": 16, "byteOffset": 2, "spanBytes": 1 } ],
               "paddingOffsets": [ … ], "poisonSensitive": true,
               "canonicalHex": "…", "canonicalHash": "0x…" } ],
  "records": [ { "name": "join_request_1local", "size": 125,
                 "fields": [ { "name": "packetVersion", "offset": 0, "size": 4,
                               "count": 1, "source": "NetRace.cpp:2449" } ] } ],
  "golden": { "schema": "blur-wire-golden/1", "source": "derived",
              "encoder": "explicit-field-wise-little-endian/1",
              "fixtures": [ { "name": "base_profile", "size": 56,
                              "sha256": "…", "fnv1a64": "0x…", "hex": "…",
                              "wcharDependent": true,
                              "rawVariant": { "size": 56, "sha256": "…",
                                              "matchesGolden": true } } ] }
}
```

`paddingOffsets` lists the bytes that lie outside every declared field *of that
type*; a nested type's internal padding is not listed (it is inside that type's
field range) but is still caught by `poisonSensitive`. Both facts matter: the
inner padding of `NetPlayerSharedProfile` shows up as `poisonSensitive` with an
empty `paddingOffsets` on `NetPlayerProfileGameData`.

`_work/net-layout/summary.json` holds the checks, the artifact SHA-256s and both
wchar deltas. `_work/net-layout/layout-table.md` is the generated table used in
`docs/work/analysis/net-layout.md`.

`--selftest` (also CTest `net_layout_selftest`) checks the invariants that hold on
every target: little-endian, `WCHAR` is `wchar_t`, the four datagram headers are
4/4/10/6 bytes, and two serialisations of the document are identical.

---

## 5. Layout

```text
probes/net-layout/
  CMakeLists.txt                 native build (MSVC /W4 /permissive-)
  src/wire_decls.h               traceable transcription of the wire declarations
  src/wire_encoder.h|.cpp        explicit little-endian encoder for the wchar_t-affected records
  src/probe_core.h|.cpp          measurement core, derived records, golden fixtures, JSON, self test
  src/probe_main.cpp             native CLI
  src/wasm_entry.cpp             wasm32 exports: wire_layout_json, wire_layout_selftest
  tests/reference_layout.py      independent layout model (msvc / itanium × wchar 2 / 4)
  tests/check_decls.py           upstream declaration + commit + clean-tree gate
  tests/verify_net_layout.mjs    node driver for the wasm module
  tests/run_net_layout.py        builds, runs, compares, writes evidence
```

---

## 6. Results

See `docs/work/analysis/net-layout.md` for the tables, the `wchar_t` delta, the
base-class tail-padding finding and the mitigation recommendation. The short
version:

* every datagram header, `NetPlayerVehicle`, `NetPlayerLoadOut`,
  `NetRaceSettings`, `NetVehicleData`, the mute list and the compressed vehicle
  blocks have the **same layout on all three targets**;
* `SysProfile::BaseProfile` does not: 56 bytes on native, 80 on default wasm32,
  and **48** with `-fshort-wchar` — so `-fshort-wchar` alone does not restore
  parity;
* `NetStartRacePacket` is 2104 / 2584 / 1944 bytes respectively.

The explicit encoder now emits the native wire bytes on all three targets:
`BaseProfile` 56, `NetStartRacePacketPlayer` 104, `NetStartRacePacket` 2104,
`join_request_1local` 125, `join_reply_host_1local` 117 and
`join_data_host_0peers` 85. The runner writes these as golden `.bin` + banner
`.json` files under `_work/net-layout/golden/` and asserts that the raw struct
path does **not** match them on wasm (while `join_data`, which has no `wchar_t`,
does). See `docs/work/analysis/net-layout.md` §11.

---

## 7. Limits

* **Static declarations only.** No packet was captured, no game was run, no
  socket was opened. Byte values here are the probe's own canonical fixtures.
* **Two compilers, one version each.** MSVC 19.44 x64 and Emscripten/Clang 24
  wasm32. A different MSVC or clang version is a new measurement.
* **No `#pragma pack`, no `-fshort-enums`, no `-m32`, no ARM.** Those are
  different ABIs and were not measured.
* **Not wired into `tools/verify_asset_probe.py`.** The main agent owns that
  file; `run_net_layout.py` is the whole gate for this probe.
* **No claim about the game.** Nothing here says the network code compiles for
  wasm, that two clients can race, or that retail accepts browser bytes.
