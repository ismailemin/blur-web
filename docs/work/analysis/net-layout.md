# T-006b — measured wire-struct ABI: native x64 vs wasm32

**Status:** measurement complete. Design recommendation only — no engine, game,
transport or fixture code was changed, and no packet was captured.
**Probe:** `probes/net-layout/` (engine-free transcription; see its `README.md`).
**Upstream:** `5270304b81983b9e3edbd569ba25235c17bbabd7`, clean working tree,
re-verified by `tests/check_decls.py` (167 declaration anchors).
**Evidence:** `_work/net-layout/`, `_work/logs/net-layout/` (git-ignored).
**Related:** `docs/work/analysis/t006-wire-format.md` §2.1/§2.2/§6.1 (S1),
`docs/work/tasks/T-006-multiplayer.md` (T-006b).

Scope labels: `engineIntegration:false`, `liveCapture:none`, `gameImplemented:false`.

This document replaces the **declaration-derived** sizes in
`t006-wire-format.md` §2.2 with measurements. Every native expectation in that
table held (56 / 24 / 12 / 24 / 10 / 4 / 10 / 6). What did not hold is the
**wasm** prediction in §2.1 — 88 bytes for `BaseProfile`, measured 80 — and the
assumption behind the `-fshort-wchar` option, that `wchar_t` width is the only
thing separating the two layouts. It is not.

---

## 1. Result in one paragraph

Every datagram header and every pure-value wire struct has the **same layout on
native MSVC x64, default wasm32 and `-fshort-wchar` wasm32**; the only outlier is
`SysProfile::BaseProfile`, which embeds `WCHAR m_Name[17]` in a class derived from
`UserIdentifier`. It measures **56 bytes native, 80 bytes default wasm32, and 48
bytes with `-fshort-wchar`**. So `-fshort-wchar` removes the 34→68-byte name
width but does **not** restore native layout: MSVC starts the derived member at
the base *size* (16) while Emscripten starts it at the base *data size* (9 → 10
with a 2-byte name), and the 6–8 recovered tail-padding bytes go the other way.
`NetStartRacePacket`, which inlines 20 of those profiles, is **2104 / 2584 /
1944** bytes. The wire format therefore cannot be "the compiler's layout" on
wasm; it has to be written down.

---

## 2. How these numbers were obtained

| concern | method |
| --- | --- |
| declarations | `probes/net-layout/src/wire_decls.h` transcribes the upstream declarations with a `file:line` per field; `check_decls.py` re-reads those lines from the committed tree and fails on any difference, on a different HEAD, or on a dirty tree |
| `sizeof`/`alignof` | the compiler, per target |
| field offset | `(char*)&obj.member - (char*)&obj` (valid for the non-standard-layout types); the real `offsetof()` is also emitted and cross-checked where the type is standard-layout |
| bitfields | one-field bit-pattern probe: all-zero object, set one bitfield to all ones, record which bits of the object representation changed |
| padding | construct the same object over `0xCD` and over `0xA5` storage, then assign every field; bytes that still differ were written by nothing, so they travel on the wire with whatever the previous stack/heap content was |
| canonical record | fixed field values over zeroed storage, whole-object hex + FNV-1a 64 |
| independent check | `tests/reference_layout.py` recomputes every size/offset/bit position from the declarations with its own algorithm, for `msvc`/`itanium` × `wchar 2`/`4`; all three targets are diffed against it and must match exactly |

Targets: `native-msvc-x64-wchar2` (MSVC 19.44, `/W4 /permissive-`, Release),
`wasm32-default-wchar4` (Emscripten/Clang 24, `-std=c++17 -O2`),
`wasm32-short-wchar2` (same + `-fshort-wchar`). MSVC has no 4-byte `wchar_t`, so
"native default" and "native `wchar_t` 2" are one build; the probe asserts
`sizeof(WCHAR) == sizeof(wchar_t)` rather than assuming it.

---

## 3. Measured layout — native MSVC x64 (the serializer authority)

| type | size/align | bytes outside every field (padding) | poison-sensitive |
| --- | ---: | --- | --- |
| `SysProfile::UserIdentifier` | 16/8 | 9–15 | yes |
| `SysProfile::BaseProfile` | **56/8** | 9–15, 50–55 | yes |
| `DatagramPacketHeader` | 4/2 | — | no |
| `DatagramUnReliablePacketHeader` | 4/2 | — | no |
| `DatagramReliablePacketHeader` | **10/2** | — | no |
| `DatagramAcknowledgementHeader` | 6/2 | — | no |
| `NetPlayerVehicle` | 24/4 | 10–11, 21–23 | yes |
| `NetPlayerLoadOut` | 12/4 | — | no |
| `NetPlayerSharedProfile` | 10/2 | 9 | yes |
| `NetPlayerProfileGameData` | 12/2 | — (inner pad at 9) | yes |
| `RaceSettings` | 32/4 | 30–31 | yes |
| `NetRaceSettings` | **84/4** | 2–3, 19, 25, 29–31, 42–43, 50–51 | yes |
| `NetStartRacePacketPlayer` | 104/8 | 62–63, 100–103 | yes |
| `NetStartRacePacket` | **2104/8** | 20–23 | yes |
| `Game::NetVehicleData` | 212/4 | 17–19 | yes |
| `CompressedNetworkControls` | 4/1 | — | no |
| `CompressedNetworkState` | 25/1 | — | no |
| `NetMuteListJoinReferences` | 24/4 | 19 | yes |
| `enum E_VEHICLE_STATE` | 4/4 | — | no |

`NetRaceSettings` is 84, not the 80 that the declaration count suggests: the
`U8` bitfield run forces three allocation units, which pushes `m_FanMultiplier`
to offset 20 and everything after it by 4. This is a compiler-defined decision
that happens to agree on both targets — but it is exactly the kind of value that
must be pinned rather than reasoned about.

Byte maps of the types that matter for fixtures (native):

```text
BaseProfile (56)
 0-7  m_Uid (u64)     8 m_IsGuest      9-15 pad
 16-49 m_Name[17] UTF-16LE            50-55 pad

NetStartRacePacket (2104)
 0-7 mHostId   8-11 mHostStartTime  12-15 mRandomSeed
 16 mNumPlayerVehicles  17 mNumAIVehicles  18 mOriginalHostJoinId  19 mEvntIndex
 20-23 pad
 24-2103 mPlayer[20] (20 x 104, filled or not — all 20 travel)

NetStartRacePacketPlayer (104)
 0-55 m_User   56 mJoinRef  57 mPrimaryJoinRef  58 mStartPos  59 mTeam
 60 mAiAvatarId  61 mAiMultiplayerRank  62-63 pad
 64-87 mVehicle  88-99 mLoadOut  100-103 pad

NetPlayerVehicle (24)
 0-3 m_xtVehicleId  4-7 m_xtColourId  8-9 {contentPack:15, autoGears:1}
 10-11 pad  12-15 m_CharacterId
 16-19 {pickupSlots:16, shieldSlots:8, additionalHealthPips:8}
 20-23 {additionalHP:1} — 1 bit used, 31 unused, bytes 21-23 never written

NetRaceSettings (84)
 0-1 m_PackVersion  2-3 pad  4-7 m_Name  8-11 m_Description  12-15 m_EventId
 16 {customRace,publicGame,ranked,championship,teams} (5 bits used of 8)
 17 {minDrivers:5}  18 {maxDrivers:5}  19 pad
 20-23 m_FanMultiplier  24 {hasAnyRacesStarted:1}  25 pad
 26-27 m_Misc  28 m_LobbyState  29-31 pad  32-35 m_LobbyTimer
 36 m_VoteCountA  37 m_VoteCountB  38-39 m_VoteIndexA  40-41 m_VoteIndexB
 42-43 pad  44-47 m_PlaylistSeed  48-49 m_PlaylistIndex  50-51 pad
 52-83 m_Race (RaceSettings)
```

### 3.1 Bit positions (the fixture authority)

Bit index is absolute from the start of the object; the LSB of a byte is bit 0.

| type | field | first bit | byte | bits covered |
| --- | --- | ---: | ---: | ---: |
| `DatagramPacketHeader` | `m_Reliable` | 16 | 2 | 1 |
| | `m_PartyChannel` | 17 | 2 | 1 |
| | `m_SenderReference` | 18 | 2 | 6 |
| | `m_PacketType` | 24 | 3 | 8 |
| `DatagramReliablePacketHeader` | `m_InitialConnection` | 32 | 4 | 1 |
| | `m_FirstPacketInStream` | 33 | 4 | 1 |
| | `m_PacketSize` | 34 | 4–5 | 14 |
| `NetPlayerVehicle` | `m_VehicleContentPack` | 64 | 8–9 | 15 |
| | `m_AutoGears` | 79 | 9 | 1 |
| | `m_PickupSlots` | 128 | 16–17 | 16 |
| | `m_ShieldSlots` | 144 | 18 | 8 |
| | `m_AdditionalHealthPips` | 152 | 19 | 8 |
| | `m_AdditionalHP` | 160 | 20 | 1 |
| `NetRaceSettings` | `m_CustomRace` | 128 | 16 | 1 |
| | `m_PublicGame` | 129 | 16 | 1 |
| | `m_Ranked` | 130 | 16 | 1 |
| | `m_Championship` | 131 | 16 | 1 |
| | `m_Teams` | 132 | 16 | 1 |
| | `m_MinDrivers` | 136 | 17 | 5 |
| | `m_MaxDrivers` | 144 | 18 | 5 |
| | `m_HasAnyRacesStarted` | 192 | 24 | 1 |

All three targets produced **identical** bit tables (`bitfieldsEqual: true` for
every type). The existing derived example in `t006-wire-format.md` §1.6 —
`0b 00 09 0e …` for `PlayerStates` — is therefore valid as written: byte 2 is
`reliable(1) | party(0) << 1 | sender(2) << 2 = 0x09`, byte 3 is the packet type,
and the reliable header is 10 bytes on every target.

---

## 4. `wchar_t` delta — default wasm32 (`wchar_t` = 4)

| type | native | wasm default | delta | what moved |
| --- | ---: | ---: | ---: | --- |
| `SysProfile::BaseProfile` | 56 | **80** | **+24** | `m_Name` 16→12 (−4), name 34→68 (+34) |
| `NetStartRacePacketPlayer` | 104 | 128 | +24 | everything after `m_User` +24 |
| `NetStartRacePacket` | 2104 | **2584** | **+480** | `mPlayer` 2080→2560 |
| all other measured types | — | — | 0 | identical, including canonical bytes |

Note the shape of the shift: `m_Name` **moves back** by 4 bytes (MSVC keeps the
base tail padding, Emscripten reuses it, and a 4-byte `wchar_t` can start at 12
rather than 16), while the array itself doubles. The net effect is +24, not the
+34 one would get by scaling the name alone. `t006-wire-format.md` §2.1 predicted
88 bytes; the measured value is 80.

Canonical byte images (zero-filled storage + identical field assignment) are
**bit-identical between native and wasm for every type that contains no
`wchar_t`** — including `NetRaceSettings`, `NetVehicleData`,
`NetMuteListJoinReferences` and the headers. That is the good news: the ABI gap
is localised, not systemic.

---

## 5. `wchar_t` mitigation — `-fshort-wchar` (`wchar_t` = 2)

| type | native | wasm `-fshort-wchar` | delta |
| --- | ---: | ---: | ---: |
| `SysProfile::BaseProfile` | 56 | **48** | **−8** |
| `NetStartRacePacketPlayer` | 104 | 96 | −8 |
| `NetStartRacePacket` | 2104 | **1944** | **−160** |
| all other measured types | — | — | 0 |

The name is 34 bytes on both targets (`m_Name.size == 34`, verified), so
`-fshort-wchar` does fix the encoding width. It does **not** fix the offset:

| | native MSVC x64 | Emscripten wasm32 |
| --- | ---: | ---: |
| `sizeof(UserIdentifier)` | 16 | 16 |
| end of last base field (`dsize`) | 9 | 9 |
| derived member start | **16** (base *size*) | **10** (base *dsize*, rounded to `alignof(WCHAR)`) |
| `offsetof(BaseProfile, m_Name)` | 16 | 10 |
| `sizeof(BaseProfile)` | 56 | 48 |

This is the Itanium "data size" rule versus MSVC's base-size rule. It is a real
ABI difference between the two toolchains, not a `wchar_t` artefact, and it
affects any wire type that inherits from a base class **with tail padding**.
`DatagramPacketHeader` is also a base in the P0 set, but its size equals its data
size (4), so the two ABIs agree there; `SysProfile::BaseProfile` is the only wire
type in the P0 set where the rule actually splits.

Measured check: the delta between native and `-fshort-wchar` wasm is **exactly**
`{BaseProfile, NetStartRacePacketPlayer, NetStartRacePacket}` and nothing else,
with `m_Name` offset −6 (16→10) and size unchanged. Both facts are asserted by
`run_net_layout.py` (`short-wchar-base-offset-delta-is-6`,
`default-wasm-delta-is-wchar-scope`).

**Conclusion: `-fshort-wchar` is not a mitigation.** It changes the failure from
"+480 bytes and a UTF-32 name" to "−160 bytes and a 10-byte field offset", which
is still a different wire.

---

## 6. P0 packet sizes (derived records)

Byte cursor over the measured `sizeof` of each embedded type; every field carries
the writer line. `join_request_1local` etc. assume one local player, which is the
only supported local-player count (`NET_MAX_LOCAL_PLAYERS = 1`, `NetDefines.h:55`).

| record | native | wasm default | wasm `-fshort-wchar` | derivation |
| --- | ---: | ---: | ---: | --- |
| `keepalive` | 4 | 4 | 4 | `DatagramPacketHeader`, `NetMessage.cpp:92-100` |
| `ack` | 6 | 6 | 6 | `DatagramAcknowledgementHeader`, `NetMessage.cpp:178-190` |
| `join_request_1local` | **125** | 149 | 117 | `NetRace.cpp:2449-2483` |
| `join_reply_host_1local` | 117 | 141 | 109 | `NetRace.cpp:897-929` |
| `join_data_host_0peers` | 85 | 85 | 85 | `NetRace.cpp:993-994` |
| `player_states_2` | 5 | 5 | 5 | `NetRace.cpp:1352-1364` |
| `vehicle_data_1local` | 38 | 38 | 38 | `GameModeNetwork.cpp:828-840` |
| `basic_vehicle_data_1car` | 39 | 39 | 39 | `RaceModeMultiplayer.cpp:977-1000` |
| `start_race_packet` | **2104** | **2584** | **1944** | `NetStartRacePacket` wholesaled, `lua_NetRace.cpp:2079` |
| `vehicle_finished` | 214 | 214 | 214 | `RaceModeMultiplayer.cpp:1705-1707` |

Fields of `join_request_1local` (native offsets), which is the first fixture that
needs the name policy:

| offset | size | field |
| ---: | ---: | --- |
| 0 | 4 | `packetVersion` (`NET_PACKET_VERSION`, runtime-configurable) |
| 4 | 1 | recipient join id |
| 5 | 8 | host console id |
| 13 | 8 | sender console id |
| 21 | 25 | DemonWare common address (`BD_COMMON_ADDR_SERIALIZED_SIZE`) |
| 46 | 2 | upstream kbps |
| 48 | 2 | downstream kbps |
| 50 | 4 | DLC mask |
| 54 | 1 | local player count |
| 55 | 56 | `SysProfile::BaseProfile` ← the only wchar-dependent field |
| 111 | 1 | voice-banned flag |
| 112 | 12 | `NetPlayerProfileGameData` |
| 124 | 1 | join id |

Fragmentation consequence (derived, not measured): the reliable writer chunks at
1024 payload bytes (`NetMessageReliableOutBox.cpp:213-220`), so
`StartRace` is 3 fragments native, 3 with 480 bytes more payload on default
wasm, and 2 with `-fshort-wchar`. A fragment-count change changes the sequence
of `m_PacketSize`/`m_TotalMessageSize` values on the wire even where the payload
fields agree.

---

## 7. Padding that currently travels

`poisonSensitive: true` means the bytes differ when the object is built over
different storage fill — i.e. the sender copies whatever was there before. Per
packet:

| carrier | unwritten bytes per instance |
| --- | --- |
| `BaseProfile` (in JoinRequest, JoinReply, JoinData, every StartRace slot) | 13 (9–15, 50–55 native) |
| `NetStartRacePacket` top level | 4 (20–23) |
| `NetStartRacePacketPlayer` | 6 (62–63, 100–103 native) |
| `NetStartRacePacket`, 20 slots | 4 + 20 × (6 + 13 inner) = **384** native |
| `NetPlayerVehicle` (VehicleData, StartRace) | 5 (10–11, 21–23) |
| `NetPlayerLoadOut` | 0 |
| `NetRaceSettings` (JoinData, NewRaceData) | 11 |
| `RaceSettings` (inside NetRaceSettings) | 2 |
| `NetPlayerProfileGameData` | 1, inside `m_Game` (offset 9) |
| `NetMuteListJoinReferences` (InitialData) | 1 (19) — `NetRace.cpp:2693` writes all 24 |
| `Game::NetVehicleData` (VehicleFinished) | 3 (17–19) |
| `UserIdentifier` standalone | 7 (9–15) |

`NetStartRacePacket` is the worst case: of its 2104 bytes, 384 are padding, and
the 20 × 34-byte `m_Name` fields are only rewritten for the slots the sender
actually fills (`GameModeNetwork.cpp:1021-1049`), so unused slots can carry the
previous race's names. None of these bytes are initialised by field assignment; a
fixture can only be canonical if the sender zeroes the packet first (or the field
list is explicit).

---

## 8. Recommendation

### 8.1 Golden packet fixture layout

Adopt the native MSVC x64 numbers as the **only** wire definition and write them
down as a field table, not as a `sizeof` reference:

* `BaseProfile` = fixed 56 bytes: `u64 uid` @0, `u8 isGuest` @8, 7 pad bytes,
  `m_Name` @16 as **17 UTF-16LE units = 34 bytes**, 6 pad bytes. The terminator
  policy must be pinned by the fixture: the constructor zeroes the whole array
  (`SystemProfile.h:101-104`), but the code that writes an actual name was not
  audited here, so "unit 16 is always NUL" is an assumption until a fixture or a
  capture proves it.
* `NetStartRacePacket` = 24 + 20 × 104 = 2104 bytes, all 20 slots always sent,
  padding zeroed.
* `NetRaceSettings` = 84 bytes with the bit table in §3.1.
* Header types keep their existing derived hex (`t006-wire-format.md` §1.6),
  which this probe confirms: 4 / 10 / 6 bytes, bit order as measured.

Fixtures must record `source: derived` until a capture promotes them, and must
include the padding bytes explicitly (zeroed) rather than excluding them, so a
comparison of the whole datagram is meaningful.

### 8.2 Serializer: explicit, not layout-dependent

**Recommended: an explicit encoder/decoder in both builds.** It is the smallest
*correct* change:

1. one header with the field order and widths from §3/§6 (no struct types on the
   wire path at all);
2. encode/decode into a byte buffer with explicit little-endian writes;
3. native keeps its legacy `memcpy` path as the *reference encoder* only, until
   the explicit encoder reproduces it byte-for-byte on captured data.

The alternative — keeping raw struct copies on both targets — requires every
compiler and flag to agree forever, which §4/§5 show they do not, and it still
leaves 384 uninitialised bytes in a `StartRace`.

**Fixed-layout wire structs** (a `#pragma pack(1)`-free struct with explicit
`u8 pad[6]` members and `u16 name[17]`) are an acceptable intermediate if the
struct is used *only* for serialization and is `memset` before being filled. They
must not be the game's own `SysProfile::BaseProfile`, or the padding/derived-class
rules reappear through the back door.

**Rejected:** raw struct copy on wasm (80-byte profile, 2584-byte StartRace);
`#pragma pack(1)` anywhere (changes the native wire, which is the authority);
`-fshort-wchar` as the mitigation (48 ≠ 56, §5).

### 8.3 Smallest mitigation, ranked

| option | change size | result |
| --- | --- | --- |
| explicit encoder for `BaseProfile`, `NetStartRacePacketPlayer`, `NetStartRacePacket` (+ the records that embed them) | ~3 types + 3 records | exact native bytes on both targets, no compiler dependency, also fixes the padding leak if the buffer is zeroed |
| fixed-layout wire structs for the same three types, `memset` + explicit padding | ~3 types | exact bytes, but two definitions of the same data to keep in sync |
| `-fshort-wchar` | one flag | wrong size (48) and wrong offset (10); rejected |
| raw struct copy with wchar 4 | none | wrong size (80/2584); rejected |

Because the ABI gap is confined to one base-class layout decision plus the
`wchar_t` width, option 1 is small: everything else already agrees byte-for-byte,
and that agreement is now measured rather than assumed.

---

## 9. Evidence

```powershell
# full gate: declaration check, native build + CTest, two wasm builds,
# three reference models, comparisons, determinism
python probes/net-layout/tests/run_net_layout.py
```

Result on this machine (MSVC 19.44.35207 x64; Emscripten/Clang 24; Node):

```text
declarations-match-upstream: PASS  check_decls: 167/167 anchors match,
                                   upstream HEAD 5270304b8198, worktree clean
native-selftest: PASS
native-deterministic: PASS
native-vs-reference(msvc,wchar2): PASS
wasm-default-deterministic: PASS
wasm-short-wchar-deterministic: PASS
wasm-default-vs-reference(itanium,wchar4): PASS
wasm-short-wchar-vs-reference(itanium,wchar2): PASS
short-wchar-name-is-34-bytes: PASS
short-wchar-still-shifts-base-class-types: PASS
short-wchar-base-offset-delta-is-6: PASS
default-wasm-delta-is-wchar-scope: PASS
default-wasm-record-delta-is-wchar-scope: PASS
wchar-free-types-have-identical-canonical-bytes: PASS
wchar-free-types-identical-on-default-wasm-too: PASS
native-wchar-2: PASS
wasm-default-wchar-4: PASS
wasm-short-wchar-2: PASS
18/18 checks passed
```

Native build: MSVC `/W4 /permissive-` **0 warnings**; CTest
`net_layout_selftest` 1/1 passed.

Artifacts (SHA-256 of the JSON documents):

| artifact | sha256 |
| --- | --- |
| `_work/net-layout/native.json` | `fdb74173c24323a2a3af30fd2bad67b2d098c4adb8b4fa82fa69fd4a2d1c1b36` |
| `_work/net-layout/wasm-default.json` | `62117cdec560f92a56e427ee4b5766f0ad8b77c61e8dc49a75c62c29747ac104` |
| `_work/net-layout/wasm-short-wchar.json` | `6a46b38b598f9f5bc3ea19570577a92482e01e38948fd2031019a86991bdc91d` |
| `_work/net-layout/summary.json` | checks, both deltas, all three builds |
| `_work/net-layout/layout-table.md` | generated table used in §3/§4 |

Logs: `_work/logs/net-layout/` (`build-native.log`, `build-wasm-*.log`,
`run-native*.log`, `run-wasm-*.log`, `reference-*.log`, `check-decls.log`,
`ctest-native.log`).

Determinism: the native binary was run twice and the wasm module twice per
target; the JSON documents are byte-identical across repeats (checked by the
runner, not by inspection).

---

## 10. What this does not prove

* **No capture.** Nothing here is compared against a datagram produced by the
  game. The retail sender is assumed to be MSVC x64 with this configuration;
  a different MSVC version or `/Zc:` setting is a new measurement.
* **No game run, no transport, no browser.** `-fshort-wchar` was measured for
  *layout* only; it also changes the ABI of every libc/libc++ function taking
  `wchar_t` (string formatting, `memset` on name buffers), which was not tested.
* **No `#pragma pack`, `-fshort-enums`, `-m32`, ARM or big-endian** measurement.
* **No parser robustness.** Truncation, count-overflow and misaligned-buffer
  behaviour (§4.6 of the wire-format document) is untouched.
* **No claim of byte compatibility.** This probe licenses the fixture layout in
  §8.1 and the encoder in §8.2; it does not make two clients race.

Next steps that depend on this document: S2 (header codec + KeepAlive/ACK/
PlayerStates fixtures, which the identical layouts make safe), then S3 (join
codec, blocked on the name policy and common-address mapping), then S4
(StartRace, which is where §7's padding and §5's offset must be resolved).
