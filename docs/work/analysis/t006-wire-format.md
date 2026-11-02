# T-006b — Golden-packet and wire-format contract (Windows ↔ WASM)

**Status:** design only. No source, upstream file, game data or task card was modified.
No build, packet capture, browser run or game run was performed for this document.
**Scope:** the application-layer datagram format used by `upstream/BlurRebuilt` for a
two-client race, and the tests needed before any WASM implementation may claim byte
compatibility.
**Upstream checkout:** `5270304b81983b9e3edbd569ba25235c17bbabd7` (clean working tree,
verified with `git rev-parse HEAD`).
**Targets compared:** MSVC x64 Windows (the retail/PC serializer authority) and
wasm32 Emscripten (future browser build).
**Related:** `docs/plan/multiplayer.md` (Turkish plan), especially items 2–5 of the
"Ölçülebilir test kapıları" section.

This document does **not** claim that the network code compiles for WASM, that any
golden packet has been captured, or that two clients can race.

---

## 1. What the wire format actually is

### 1.1 There is no serializer — the struct is the wire

Every datagram is written by copying a C++ struct into the message buffer:

- `C_NetMessage::CreateUnReliable()` writes `sizeof(DatagramUnReliablePacketHeader)`
  with `WriteToBuffer` (`Message/NetMessage.cpp:92-100`), which is a `memcpy`
  (`Message/NetMessage.cpp:670-680`).
- `C_NetMessageReliableOutBox::Add()` builds a `DatagramReliablePacketHeader` on the
  stack and writes `sizeof(hdr)` into the outbox (`Message/NetMessageReliableOutBox.cpp:250-272`).
- Acknowledgements are written the same way (`Message/NetMessage.cpp:178-190`).

The reader does the inverse: it casts the received `U8` buffer to
`DatagramPacketHeader*` (`Router/NetRouterBase.cpp:215`), to
`DatagramReliablePacketHeader*` (`Router/NetRouterBase.cpp:226`), and reinterprets
the message buffer in the inbox (`Message/NetMessageReliableInBox.cpp:78,148`).
Alignment of the byte buffer is therefore already assumed, not guaranteed.

**Consequence:** "the wire format" is the compiler's memory layout of these structs.
MSVC and Clang/WASM agreement is a property that must be tested, not a design
guarantee. This is the exact risk already recorded in `docs/plan/multiplayer.md:20`.

### 1.2 Header layout and bit allocation

`DatagramPacketHeader` (`Misc/NetDatagramHeader.h:24-34`):

| offset | size | field | notes |
|---:|---:|---|---|
| 0 | 2 | `U16 m_EncryptedBytes` | first two bytes of **every** datagram (comment at line 29) |
| 2 | 1 | bitfield byte 0 | `m_Reliable:1` (bit 0), `m_PartyChannel:1` (bit 1), `m_SenderReference:6` (bits 2–7) |
| 3 | 1 | bitfield byte 1 | `m_PacketType:8` |

The four bitfields share one `U16` allocation unit in declaration order
(`Misc/NetDatagramHeader.h:30-33`). On little-endian targets this means the
least-significant bit of the 16-bit word is `m_Reliable`; a WASM build must reproduce
that bit order, not merely the field widths.

`DatagramReliablePacketHeader` (`Misc/NetDatagramHeader.h:44-55`) adds a second
`U16` bitfield word and two plain `U16`s:

| offset | size | field |
|---:|---:|---|
| 0 | 4 | `DatagramPacketHeader` |
| 4 | 2 | `m_InitialConnection:1`, `m_FirstPacketInStream:1`, `m_PacketSize:14` |
| 6 | 2 | `m_TotalMessageSize` |
| 8 | 2 | `m_PacketSequence` |

`DatagramAcknowledgementHeader` (`Misc/NetDatagramHeader.h:57-64`) is the 4-byte base
plus `U16 m_PacketSequence` at offset 4.

`m_PacketSize` includes the header (`Message/NetMessageReliableOutBox.cpp:260`) and
is used to walk the outbox (`:118-143`, `:300-314`). `m_TotalMessageSize` includes
the header once and is compared against the accumulated inbox bytes
(`Message/NetMessageReliableInBox.cpp:149`).

**`m_EncryptedBytes` is a length, not encryption.** `EncryptedSize` is
`bdBitBuffer::endianSwap` (`Misc/NetEncrypted.h:25-28`), which is an identity copy on
little-endian targets (`vendor/demonware/2.0/bdCore/bdContainers/bdBitBuffer.h:543-556`).
The value is the byte count *after* the first two bytes and is used to find the
unencrypted voice tail of an unreliable datagram (`Message/NetMessage.cpp:126`,
`:441-451`; `Router/NetRouterBase.cpp:253-263`). The actual encryption on the retail
path is the DemonWare DTLS association under `bdSocketRouter`, not this field. A
WebRTC transport must not add a second interpretation of this field.

### 1.3 Reliable framing, sequence and ACK

- Reliable payloads are split into 1024-byte chunks and each chunk is prefixed with
  its own 10-byte header (`Message/NetMessageReliableOutBox.cpp:213-220`, `:244-272`).
- Party and race channels use **separate** 16-bit sequence counters
  (`Message/NetMessageReliableOutBox.cpp:262-265`). Sequence 0 is used for
  `m_InitialConnection` packets (`:263-265`), which is how `JoinReply` is marked
  (`Core/NetRace.cpp:963`); the normal counters start at 1.
- Only the **first** packet in the outbox is transmitted per poll; later fragments
  wait for the first packet's ACK to be removed
  (`Message/NetMessageReliableOutBox.cpp:178-180`, `:290-320`). This is stop-and-wait
  at packet granularity, not a sliding window.
- The ACK is an unreliable datagram carrying only the packet sequence
  (`Message/NetMessage.cpp:157-198`). The receiver ACKs **every** reliable datagram,
  including one whose sequence was not the expected next value
  (`Message/NetMessageReliableInBox.cpp:85-123`). A mismatched ACK is ignored by the
  sender because it compares only against the first queued packet
  (`Message/NetMessageReliableOutBox.cpp:295-297`).
- Duplicate/out-of-order reliable packets are not copied into the inbox and are not
  buffered (`Message/NetMessageReliableInBox.cpp:85-117`).

### 1.4 Join and session message shapes

The join path is byte-defined by `C_NetRace`:

- **JoinRequest** — unreliable, built at `Core/NetRace.cpp:2432-2495`: `U32` packet
  version (`:2449`), `U8` recipient join id (`:2457`), host and sender console ids
  (`:2459-2460`), `BD_COMMON_ADDR_SERIALIZED_SIZE` opaque common address
  (`:2461`), up/down bandwidth `U16`s, DLC mask `U32`, local player count, then per
  local player `sizeof(SysProfile::BaseProfile)` + voice-banned `U8` +
  `sizeof(NetPlayerProfileGameData)` + join id `U8` (`:2478-2483`).
- **JoinReply** — reliable, `m_InitialConnection=1` (`Core/NetRace.cpp:963`), with a
  host/peer branch (`:892-956`). The host branch carries `sizeof(BaseProfile)` and
  `sizeof(NetPlayerProfileGameData)` blobs (`:924-927`).
- **JoinData** — reliable, host only (`Core/NetRace.cpp:967-1019`): the entire
  `NetRaceSettings` struct (`:993`), a peer count, then per peer console id, local
  index, opaque common address, bandwidth, DLC mask, voice flag,
  `sizeof(NetPlayerProfileGameData)`, `sizeof(SysProfile::BaseProfile)`, join id,
  player state, team (`:1001-1012`).
- **InitialData** — reliable (`Core/NetRace.cpp:2659-2725`): request flag, local
  count, then per player join id/state, `sizeof(NetPlayerProfileGameData)`,
  `sizeof(NetMuteListJoinReferences)`, communicator flag, and 8 nonce bytes written
  one at a time (`:2687-2699`).
- **PlayerStates** — reliable, the only "ready/load" message: `U8` count followed by
  `U8` join id + `U8` state pairs (`Core/NetRace.cpp:1337-1379`). States are the raw
  enum values from `Player/NetPlayerStates.h:22-53`.
- **NewRaceData** — reliable, `sizeof(NetRaceSettings)` only
  (`Core/NetRace.cpp:2623-2636`).

`JoinRequest` is re-sent every 1.5 s once the transport reports "connected"
(`Core/NetRace.cpp:1933-1948`) and the join has a 15 s budget
(`Misc/NetDefines.h:70-71`). In the browser, "connected" must mean DataChannel open,
not merely ICE connected.

The packet version in `JoinRequest` is **not a compile-time constant** in non-gold
builds: `NET_PACKET_VERSION` is a persisted `Debug::Enum` defaulting to
`eNetBuildVersion_Master` (`Lan/NetLanDiscovery.cpp:30-32`), while the gold build uses
`0x0F000001` (`Misc/NetVersion.h:39-43`). A golden fixture for JoinRequest must record
and pin the value actually used by the build.

### 1.5 Game-level messages also copy raw structs

These are outside the Network library but are on the required race path:

- **StartRace** — reliable, `sizeof(NetStartRacePacket)` copied wholesale
  (`GameLogic/Lua/lua_NetRace.cpp:2074-2080`). The packet contains a 20-element
  inline array of `NetStartRacePacketPlayer`, each embedding `SysProfile::BaseProfile`
  by value (`GameLogic/Structures/NetStartRacePacket.h:17-47`).
  `BuildStartRacePacket` fills only the used slots (`GameLogic/GameModes/GameModeNetwork.cpp:1021-1049`);
  the full 20-slot array is nonetheless transmitted. No `memset` of the packet was
  found in the build path, so unused slots can retain the previous race's bytes.
- **VehicleData** — reliable, `sizeof(NetPlayerVehicle)` and
  `sizeof(NetPlayerLoadOut)` blobs (`GameLogic/GameModes/GameModeNetwork.cpp:839-840`,
  parsed at `:612-670`).
- **BasicVehicleData** — unreliable. Writes `U8` car count, then per car join id,
  `sizeof(CompressedNetworkControls)` (4 raw bytes), `sizeof(CompressedNetworkState)`
  (25 raw bytes), health `S32`, pickup `U32`, then event data, then voice
  (`GameLogic/RaceModes/RaceModeMultiplayer.cpp:969-1003`). The compressed structs are
  plain byte arrays (`mercury/library/physics/racingphysics/include/racingphysics/Vehicles/vehicle.h:93-101`),
  so their *layout* is safe, but their *encoding* still has to match.
- **VehicleFinished** — reliable, `sizeof(NetVehicleData)` copied wholesale
  (`GameLogic/RaceModes/RaceModeMultiplayer.cpp:1699-1712`, parsed `:1715-1749`).
- **Pickup / weapon / damage** — not separate messages; they are variable-length
  events appended to `BasicVehicleData`. The event manager writes `U8 eventCount`
  and then each event (`GameLogic/Structures/NetEventManager.cpp:599-623`). Event
  ids are `E_NetEventType` (`GameLogic/Structures/NetEventPackets.h:11-39`); the
  reader dispatches on them in `GameLogic/RaceModes/RaceModeMultiplayer.cpp:1890-1916`.
  Some events are explicitly written (`NetEventManager.cpp:166-220`, `:324-345`), but
  `PickupKilled` and matrices are raw struct/array pushes
  (`NetEventManager.cpp:280`, `:292`, `:306`).
- **PostRace** — reliable, per local player `U8` join id +
  `sizeof(NetPlayerProfileGameData)` (`Core/NetRace.cpp:1577-1629`).

There is **no dedicated respawn message** in `NetDatagramPacketTypes.h:29-74`.
Health is replicated in every `BasicVehicleData` (`RaceModeMultiplayer.cpp:999`,
`:1055`, applied at `:1080`), and "repaired" exists only as an event used by the
Hand of God ability (`Game/GameActors/Components/VehicleLogic/HandofGod/VLC_HandOfGod.cpp:230`).
Whether every respawn is fully determined by replicated health plus player state was
**not** verified; it must be checked against a captured race before claiming respawn
parity.

### 1.6 Derived canonical examples (not yet captured)

These are hand-derived from the declarations above. They are useful as the first
fixtures, but they are **hypotheses** until the layout probe in §4 confirms
`sizeof(DatagramReliablePacketHeader) == 10` and the bit order.

| case | bytes (hex) | derivation |
|---|---|---|
| KeepAlive, sender 2 | `02 00 08 02` | size=4−2; reliable=0, party=0, sender=2, type=2 |
| ACK, sender 2, seq `0x1234` | `04 00 08 01 34 12` | size=6−2; type=1; seq LE |
| PlayerStates, sender 2, seq 1, `(1,2,Idle=4)` | `0b 00 09 0e 36 00 0d 00 01 00 01 02 04` | size=13−2; type=14; first=1; packetSize=13; total=13 |

The third row assumes the reliable header is 10 bytes. If the probe measures a
different size, every byte after offset 0 in that row changes; that is exactly why the
probe runs before the fixtures are frozen.

---

## 2. ABI risk register

### 2.1 Biggest single risk: `wchar_t` inside `SysProfile::BaseProfile`

`BaseProfile` embeds `WCHAR m_Name[SYSTEM_PROFILE_NAME_LENGTH]`
(`mercury/library/network/include/SystemProfile/SystemProfile.h:88-108`), and `WCHAR`
is `wchar_t` (`mercury/library/common/core/include/core/Core.h:547`). It is copied raw
into JoinRequest, JoinReply, JoinData and StartRace.

- MSVC x64: `wchar_t` is 2 bytes; the name is 34 bytes for 17 units.
- Emscripten wasm32: `wchar_t` defaults to 4 bytes; the current project wasm build
  passes no `-fshort-wchar` (`tools/build_asset_probe.py:48`), so the default applies
  unless the future network build changes it.
- Effect: the struct grows from an expected 56 bytes to an expected 88 bytes under
  MSVC and wasm32 respectively, the UTF-16LE name becomes UTF-32LE, and every field
  after the name shifts. In a 20-slot StartRace this is a shift of hundreds of bytes
  and can change the fragment count.
- Detection: `sizeof`/pattern probe (§4.3) and a name-encoding fixture.

**Recommendation:** do not rely on `wchar_t` on WASM. Define the wire name as exactly
17 UTF-16LE units (34 bytes), with a fixed terminator policy, in an explicit encoder.
Keep the native raw path as the reference until parity is proven.

### 2.2 Systemic risk: raw structs with implicit padding and bitfields

Padding bytes are part of the `memcpy` but are not initialized by field assignment.
They can differ between compilers, builds and runs even when every field matches.

Derived expectations (declaration-derived, **not measured**; must be pinned by
`static_assert`/probe):

| type | expected size/align (MSVC x64) | padding that is currently sent |
|---|---:|---|
| `DatagramPacketHeader` | 4 / 2 | none |
| `DatagramReliablePacketHeader` | 10 / 2 | none expected |
| `DatagramAcknowledgementHeader` | 6 / 2 | none expected |
| `SysProfile::BaseProfile` | 56 / 8 | 7 bytes after `m_IsGuest`, 6 tail bytes |
| `NetPlayerVehicle` | 24 / 4 | 2 bytes before `m_CharacterId` |
| `NetPlayerLoadOut` | 12 / 4 | none |
| `NetMuteListJoinReferences` | 24 / 4 | 1 byte after the 19-element storage |
| `NetPlayerSharedProfile` | 10 / 2 | 1 tail byte |

Relevant declarations: `Network/Player/Data/NetPlayerRaceData.h:48-60` (`NetPlayerVehicle`
bitfields, including a 1-bit `U32` that consumes a whole 4-byte unit),
`:63-76` (`NetPlayerLoadOut`), `Network/Player/Data/NetPlayerProfileData.h:24-42`
(`NetPlayerSharedProfile`), `Misc/NetDefines.h:138` (`NetMuteListJoinReferences`),
and `Misc/NetRaceSettings.h:133-165` (11 bits declared across `U8` bitfields, which
forces a second allocation unit).

The mute list is a concrete leak: `InitialData` writes `sizeof(muteList)`
(`Core/NetRace.cpp:2693`) even though the 19th byte and beyond are padding.

### 2.3 Other risks

| risk | where | why it matters |
|---|---|---|
| Full 20-slot StartRace array is sent, only `mNumPlayerVehicles` slots are rewritten | `GameModeNetwork.cpp:1021-1049`, `lua_NetRace.cpp:2079` | stale player names/ids and nondeterministic bytes in unused slots |
| `NetPlayerVehicle` has 1-bit fields in new allocation units | `NetPlayerRaceData.h:55-59` | 31 unused bits; a compiler that packs differently changes the size |
| `NetRaceSettings` mixes `U8` bitfields totalling 11 bits | `NetRaceSettings.h:140-152` | allocation-unit boundary is compiler-defined in principle |
| `bool` and enum sizes | `NetPlayerProfileData.h:40-41`, `NetVehicleData.h:53` | assumed 1 and 4 bytes; must be asserted |
| `BD_COMMON_ADDR_SERIALIZED_SIZE` is DemonWare-specific | `vendor/demonware/2.0/bdCore/bdSocket/bdCommonAddr.h:34-49` | cannot be produced by a WebRTC peer; it is an opaque transport blob, not game state |
| `NET_PACKET_VERSION` is runtime-configurable | `Lan/NetLanDiscovery.cpp:30-32` | the same build can emit different join bytes |
| No pointer-bearing container is serialized in the required slice | `Btl::VectorParameters_Array/Static` use inline storage (`mercury/.../btl/Containers/vector.h:34-120`, `:830-853`) | good news: 64-bit vs 32-bit pointer width is not the primary problem for these packets |

The last row was checked for `NetStartRacePacket`, `NetPlayerLoadOut`,
`NetVehicleData` and `NetMuteListJoinReferences`. It does not prove safety for later
packets that may contain dynamic containers; each new packet needs the same check.

---

## 3. Packet inventory for the first two-client race

Topology assumed for the first slice: **one host + one joining client**, both
rendering, race channel only. In that topology the host's additional-peer list in
JoinData is expected to be empty (`Core/NetRace.cpp:971-986`), so the multi-peer
handshake does not need to work yet. That expectation is not yet verified by capture.

If the first slice is launched through the party lobby instead of a direct race
session, the party join path (`Core/NetParty.cpp:292-302`, `:1385`,
`:2878-2884`, `:3090-3096`) becomes required as well. The direct race path in this
table does not need it.

### 3.1 Required (P0)

| id | message | channel | reliability | direction | payload authority |
|---:|---|---|---|---|---|
| 1 | `ReliableAcknowlegement` | race | unreliable | both | `NetMessage.cpp:157-198` |
| 2 | `KeepAlive` | race | unreliable, header only | both | `NetPlayerManager.cpp:395-426` |
| 3 | `JoinRequest` | race | unreliable | client→host | `NetRace.cpp:2432-2495` |
| 4 | `JoinReply` | race | reliable, initial | host→client | `NetRace.cpp:886-963` |
| 5 | `JoinData` | race | reliable | host→client | `NetRace.cpp:967-1018` |
| 7 | `InitialData` | race | reliable | both | `NetRace.cpp:2659-2725` |
| 14 | `PlayerStates` | race | reliable | all peers | `NetRace.cpp:1337-1379` |
| 15 | `VehicleData` | race | reliable | per peer | `GameModeNetwork.cpp:824-848` |
| 16 | `StartRace` | race | reliable, fragmented | host→idle peers | `lua_NetRace.cpp:2077-2092` |
| 23 | `BasicVehicleData` | race | unreliable | per peer | `RaceModeMultiplayer.cpp:839-868` |
| 24 | `VehicleFinished` | race | reliable | per peer | `RaceModeMultiplayer.cpp:1682-1696` |

Notes on the sequence:

1. **Join/ready/load has no separate "ready" packet.** `PlayerStates` carries
   `LoadingRace=7`, `WaitingForOthers=15`, `Racing=16`, `Finished=17`
   (`NetPlayerStates.h:22-53`) and is the only state transition message
   (`lua_NetRace.cpp:1545-1549`, `:1587-1595`, `:1628-1638`).
2. **StartRace is only sent to peers in `Idle` or `ChangingCar`**
   (`lua_NetRace.cpp:2089`). A client left in another state is silently skipped.
   The test sequence must therefore be: join complete → Idle → StartRace → Loading →
   Waiting → Racing.
3. **Finish ordering** is `VehicleFinished` (reliable) plus the `Finished` player
   state. `PostRace` is not required to stop a vehicle but is required for the results
   data to be consistent, so it is P1 rather than P0.
4. **Respawn** has no packet. It must be expressed through BasicVehicleData health,
   player state, and (for Hand of God) the `Repaired` event. Treating it as a
   separate message would be an invented protocol.

### 3.2 Event types inside BasicVehicleData

Required for a normal race (subset, order by `E_NetEventType` value):

| id | event | wire shape (derived) | used by |
|---:|---|---|---|
| 1 | `DroppedPickupPickedUp` | `U32` pickup uid | `NetEventManager.cpp:139-151` |
| 2 | `PickupDroppedOnTrack` | `U32`, `U8` type, `U8` join, 48-byte matrix | `:298-309` |
| 5 | `PickupFired` | `U16` flags + variable fields incl. optional 48-byte matrix | `:166-220` |
| 8 | `HitByPickup` | 4×`U8`, `U32`, `U16`, 2×3 floats | `:324-345` |
| 9 | `Ghosted` | `U8`, `F32` | `:370-380` |
| 13 | `Repaired` | `U8` | `:464` |
| 17 | `DamageDealt` | `U8`, `U8`, `S16` | `NetEventManager.h:74` |
| 18 | `AbilityActivated` | `U8`, `U8`, ability, flag | `NetEventManager.h:75` |
| 20 | `JudgedPowerupHit` | same shape as `HitByPickup` | `:327` |

Later: `PickupKilled` (raw `PickupAutopsyReport`), `MineMoved`, `Eliminated`,
`ShieldedPickup`, `Score_Aggressive`, `MineDestroyedByProjectile`,
`SetPowerupRespawnDelay`, `EvadedShock`, `HitAllShockDomes`, `SilentRunning`.
Voice bytes are appended after the event block and after `StartUnEncryptedData`
(`RaceModeMultiplayer.cpp:878-904`).

### 3.3 Later / not required for the first slice

- **P1:** `Leaving` (9), `NewRaceData` (8), `PostRace` (28), `LobbyUpdate` (29),
  `ForceRaceTimeout` (32). Needed for clean teardown, rematch and result screens.
- **P2:** `LobbyWaitingRaceInfo` (27), `AwardsData` (17), vote messages (18–20),
  `BeginVoting` (30), `CommunicatorStatusUpdate` (31), `MuteChange` (22).
- **P3:** party messages (25–26), `BasicVoice` (21), migration (11–13),
  `DisconnectConsoles` (10), LAN discovery. Discovery is replaced by room codes;
  its port and raw structs (`Lan/NetLanDiscoveryDefines.h:31-68`) are not a browser
  contract.

Packet ids are derived from the declaration order in
`Misc/NetDatagramPacketTypes.h:29-74`; the test must pin them with an enum-to-id
fixture because inserting an enum value is a wire break.

---

## 4. Golden-packet test design

The goal is a contract, not a reimplementation. Three independent views must agree:

1. native legacy bytes (raw struct `memcpy`, the reference);
2. an explicit byte-level encoder used by WASM (and later by native);
3. an independent Python reference encoder that knows only the field values.

If native and WASM share a wrong assumption, the Python reference catches it.

### 4.1 Evidence sources

**Source A — capture at the router boundary.** Instrument the arguments of
`C_NetRouterBase::SendMessage(U8*, size, addr)` and `SendMessage(C_NetMessage&, addr)`
(`Router/NetRouterBase.cpp:503-593`), plus the receive buffer at
`Router/NetRouterBase.cpp:189`. This is plaintext application data, **before** DTLS.
Capturing at the UDP socket would only record ciphertext.

Raw captures contain player names, console ids and DemonWare ids. They stay in
`_work/` (git-ignored) and are referenced by SHA-256. Committed fixtures are
**synthesized** by the test harness with fixed names/ids/nonces/times, or are captures
with those fields redacted. No game data, profile data or personal identifiers are
committed.

**Source B — deterministic harness.** A native test binary constructs messages with a
stub router/listener and fixed inputs. Game-level packets (`StartRace`,
`BasicVehicleData`, `VehicleFinished`) need either a capture or a harness that can
construct the structs without running the game. StartRace must not be built from live
time: `mRandomSeed` and `mHostStartTime` come from `Time::GetCurrentTime()`
(`GameModeNetwork.cpp:1010,1016`) and must be overwritten with fixture values.

**Source C — replay.** Captured native datagrams are fed into the WASM decoder and the
decoded field values are compared with the native decode. This proves the reader even
before the WASM encoder exists.

### 4.2 Fixture format

One JSON file per case plus a binary blob, or a single manifest with inline hex:

```json
{
  "schema": "blur-wire/1",
  "case": "reliable_player_states_idle",
  "source": "derived|synthesized|capture-redacted",
  "upstream_commit": "5270304b81983b9e3edbd569ba25235c17bbabd7",
  "build": { "native": "MSVC x64 Release", "wasm": "em++ <version> <flags>" },
  "packet_version": "0x0A000060",
  "channel": "race",
  "reliable": true,
  "sender_ref": 2,
  "packet_type": 14,
  "sequence": 1,
  "length": 13,
  "hex": "0b00090e36000d000100010204",
  "sha256": "<hash>"
}
```

Rules:

- Fixed, documented inputs only. No wall-clock, no random nonce, no real names.
- `packet_version` is mandatory for JoinRequest and must name the build config.
- A fixture is immutable once accepted; a format change creates a new case, it does
  not edit history.
- `source: derived` means "hand-derived, awaiting capture"; it may not be used as
  proof of parity until promoted.

### 4.3 Layout probe (runs first)

A probe binary compiled for both targets emits JSON:

- `sizeof` and `alignof` of every raw type written to the wire;
- `offsetof` for every non-bitfield member;
- for bitfields: a **bit-pattern probe** — zero the object, set exactly one field to a
  marker, write the object, and record which bits changed.

Bitfields cannot be `offsetof`-ed, and `offsetof` on non-standard-layout types is
conditionally supported, so the pattern probe is the authoritative check for
`DatagramPacketHeader`, `DatagramReliablePacketHeader`, `NetPlayerVehicle` and
`NetRaceSettings`.

Gate: native JSON and wasm JSON are identical for every type that the WASM path will
read or write. If a type is intentionally not used on WASM (because only the explicit
encoder is used), the report must say `"wasmRawLayout": "notUsed"` rather than omit it.

### 4.4 Byte parity and determinism

For each fixture:

1. Native encodes the packet with the legacy path and records hex + SHA-256.
2. WASM encodes the same field values with the explicit encoder and records the same.
3. Python re-encodes from the JSON field values and records the same.
4. Run each encoder three times and across two builds (Debug/Release, `-O0`/`-O2`);
   all hashes must be identical.

**Padding poison test:** fill the destination/struct storage with `0xCD`, then with
`0x00`, then with `0xA5`, run the same construction and serialization. If the output
bytes change, the packet contains uninitialized padding and may not be used as a
canonical fixture until either (a) the padding is explicitly zeroed, or (b) the type is
moved to the explicit encoder. This test is mandatory for `BaseProfile`,
`NetPlayerVehicle`, `NetMuteListJoinReferences`, `NetPlayerSharedProfile`,
`NetStartRacePacketPlayer` and `NetVehicleData`.

**StartRace staleness test:** build the packet twice in one process with different
player counts and compare the bytes in slots `[mNumPlayerVehicles, 20)`. If they
change, the production sender is leaking stale session data; the fixture must use a
zeroed packet and the leak must be recorded as a known defect, not reproduced as
"canonical".

### 4.5 Endian and packing checks

- Both targets are little-endian. Assert it at compile time and fail the build if
  `BD_BIG_ENDIAN` is defined; `EncryptedSize` would swap the size field on a big-endian
  target (`bdBitBuffer.h:545-556`), producing a different wire.
- The contract is explicitly little-endian for every multi-byte field, including the
  `m_EncryptedBytes` length. Do not "improve" it to network byte order.
- Do not add `#pragma pack(1)`. The native layout is the reference; changing packing
  changes the wire for existing peers.
- The LAN discovery path uses `htonl` for its version (`Lan/NetLanDiscovery.cpp:139`),
  unlike race packets. That protocol is replaced, not merged; do not apply its byte
  order to race datagrams.
- Assert no pointer-sized field is written by any packet in §3. Re-run this check
  whenever a new packet is added.

### 4.6 Malformed-length and parser-robustness corpus

For every fixture, generate:

- every truncation prefix from 0 bytes to `length-1`;
- mutations of `m_PacketSize`, `m_TotalMessageSize`, `m_PacketSequence`,
  `m_FirstPacketInStream`, `m_EncryptedBytes`;
- count fields set to 0, 1, max, max+1 (`numLocal`, `numCars`, `numPeers`,
  `numToJoin`, `mNumPlayerVehicles`, `numEvents`);
- a name with 17 non-zero units and no terminator;
- an event matrix truncated mid-float;
- an unknown join id in `VehicleFinished`.

Expected result: explicit reject/ignore, no out-of-bounds read, no trap, no abort in
Release. Run native under ASan; run wasm with bounds checking enabled if available.

Known parser hazards to encode as *expected current behaviour*, not as desired
behaviour:

- `NetRace.cpp:2507` and `:2649` use `ok == ok &&` (comparison, not assignment), so
  a truncated `NetRaceSettings` read does not set `ok` to false.
- `NetRace.cpp:517-525` loops to `mNumPlayerVehicles` read from the packet without
  validating it against `NET_MAX_VEHICLES` (20).
- `RaceModeMultiplayer.cpp:1735-1743` reads `NetVehicleData` only when the join id is
  known, so an unknown id leaves the stream misaligned.
- `NetMessageReliableInBox.cpp:102-110` refuses to copy when the inbox is full but
  still ACKs the packet (`:119-123`), so a too-large `m_TotalMessageSize` can stall a
  reliable stream.
- `NetRouterBase.cpp:534` asserts on a malformed reliable send; Release behaviour
  differs from Debug.

These are findings for T-006 implementation, not fixes in this task.

### 4.7 What the golden test cannot prove

- It cannot prove the retail client accepts browser bytes if any transport-dependent
  field (common address, security id, nonce semantics) is substituted.
- It cannot prove event semantics, only byte equality. Drop behaviour and event-number
  loss must be tested at the transport/adapter level.
- It cannot prove timing. The 0.5 s retry, 1.5 s join resend and 4/6 s dropout are
  separate transport tests.

---

## 5. Transport contract: what WebRTC provides, what must be preserved

Retail transport is a DemonWare DTLS association exposed as `bdSocketRouter`;
`SendMessage` refuses to send unless the address status is `BD_SOCKET_CONNECTED`
(`Router/NetRouterBase.cpp:518-520`, `:573-575`). Peer identity is a
`bdAddrHandleRef` plus a serialized DemonWare common address
(`Core/NetJoinHelper.cpp:242-263`; `Core/NetRace.cpp:2577-2586`).

### 5.1 What WebRTC changes

| retail mechanism | WebRTC equivalent | consequence |
|---|---|---|
| DTLS association per peer | DTLS on the DataChannel | payload bytes remain plaintext to the app; do not add another cipher |
| `bdSocketRouter::sendTo` synchronous byte count | `RTCDataChannel.send()` + `bufferedAmount` | send may be accepted but not yet on the wire; backpressure must be explicit |
| UDP datagrams | SCTP messages, optionally fragmented | message boundaries preserved, but delivery/latency profile differs |
| `bdAddrHandleRef` | channel/peer id | map at the adapter; never serialize the handle |
| LAN broadcast discovery | room code / signaling | discovery structs and port 50001 are not reused |
| `BD_COMMON_ADDR_SERIALIZED_SIZE` blob | none | requires a documented browser mapping or a deliberate protocol substitution |

### 5.2 What must be preserved

| property | source | must-preserve rule |
|---|---|---|
| App header bytes and bit order | `DatagramPacketHeader` | exact bytes, little-endian |
| Reliable seq / ACK / retry | `OutBox.cpp:262-265`, `:290-320` | keep the app layer; do not double-retransmit |
| Stop-and-wait fragmentation | `OutBox.cpp:178-180` | one in-flight reliable fragment, 1024-byte chunks |
| Unreliable no-retry | `NetMessage.cpp:71-105` | vehicle updates may drop; never upgrade them to reliable |
| Keepalive 0.5 s, dropout 4/6 s | `NetDefines.h:78-84`, `Core/NetRace.cpp:1775-1778` | keep app liveness; ICE state alone is too slow |
| Join resend 1.5 s, timeout 15 s | `Core/NetRace.cpp:1937`, `NetDefines.h:70-71` | start the timer at DataChannel open |
| MTU budget 1024 / reliable frame 1034 | `NetDefines.h:40`, `OutBox.cpp:213-220` | never enlarge a frame to the SCTP limit |
| Party/race sequence separation | `OutBox.cpp:262-265` | separate channels and counters, even in 1v1 |

### 5.3 Recommended channel plan

- **One DataChannel per peer**, unordered, `maxRetransmits: 0`, one message per app
  datagram. This reproduces UDP semantics and leaves reliability entirely to the
  application, which is the only way to keep the existing ACK/retry behaviour
  comparable.
- If a second channel is used for voice later, it must not share sequence counters.
- Do **not** enable SCTP retransmission on the reliable stream initially: the app
  already retransmits every 0.5 s; double retry hides loss and changes timing.
- Treat `send()` acceptance as the analogue of `sendTo` returning `size`. If the
  buffer is above the low-water mark, return failure for unreliable data (drop it) and
  keep reliable data in the outbox (retry). Never report success for data that was not
  queued.
- Map DataChannel close/ICE failure to an explicit disconnect; do not wait for the
  4/6 s app timeout if the channel is already known dead.

### 5.4 MTU and fragmentation

The app already fragments at 1024 bytes of payload plus a 10-byte header. SCTP may
fragment again, but a 1034-byte message plus DTLS/SCTP/IP overhead normally fits a
1280-byte path. Keep the app limit unchanged; do not rely on SCTP's larger message
size, and do not send a 64 KB StartRace as one message.

---

## 6. Minimal first slice and acceptance criteria

### 6.1 Slice definition

**S0 (this document):** contract and test design only.

**S1 — layout probe.** Native and wasm probes for the types in §2.2 plus
`NetStartRacePacket`. Output JSON, diff, and commit the reviewed baseline. No network
code yet.

**S2 — header codec.** Explicit encoder/decoder for the four header structs and the
size field; fixtures for KeepAlive, ACK, and one reliable single-fragment message
(PlayerStates). This is enough to prove bit order, size field and sequence.

**S3 — join codec.** JoinRequest, JoinReply, JoinData, InitialData. Requires the
`wchar_t`/name policy and the common-address policy to be decided. Include the
`packet_version` pin.

**S4 — race codec.** StartRace (full 20-slot array), VehicleData, VehicleFinished,
BasicVehicleData with event blocks. Uses native capture for authority.

**S5 — two-adapter rehearsal.** Two adapters exchange the golden sequence over a
DataChannel with 0% and 10% loss. Reliable messages must arrive in order and recover;
unreliable messages may drop without stalling. This is not a playable race.

### 6.2 Acceptance criteria

- [ ] Layout JSON is identical for native and wasm, or explicitly marked
      `notUsed` for a type the wasm path never touches; bit-pattern probes match.
- [ ] Every P0 packet has at least one fixture with `source` recorded; every
      `derived` fixture has been promoted by capture or marked as unproven.
- [ ] Native legacy bytes, wasm explicit bytes and the Python reference are identical
      for every fixture; SHA-256 recorded.
- [ ] Three repeat runs and two optimization levels produce identical hashes.
- [ ] Padding poison test passes for every raw type in §2.2, or the type is excluded
      from the raw path with a recorded reason.
- [ ] Malformed corpus produces no OOB, no trap and no Release abort; each known
      parser hazard in §4.6 has a recorded expected result.
- [ ] Two-adapter rehearsal: reliable join/start/finish delivered under 10% loss
      within the retry budget; unreliable vehicle updates may drop and do not block.
- [ ] Every substituted or unsupported field is labelled (`addressMapping`,
      `partyChannel:"unsupported"`, `voice:"unsupported"`), not silently zeroed.
- [ ] No real player name, console id, profile id or game data is committed.

### 6.3 Non-goals

No gameplay, rendering, matchmaking, TURN deployment, host migration, voice,
NAT traversal, retail-client interoperability, or two-client browser race in T-006b.
Those belong to later T-006 slices.

---

## 7. Unknowns and decisions required

1. **Measured layout.** All sizes in §2.2 are declaration-derived, not measured.
   Nothing may be frozen until the S1 probe reports native values.
2. **`wchar_t` policy.** Explicit UTF-16LE encoder vs `-fshort-wchar`. The first is
   recommended; the second is fragile and still leaves padding.
3. **Common address mapping.** `BD_COMMON_ADDR_SERIALIZED_SIZE` is a DemonWare
   transport blob. It is deserialized by the host at `Core/NetRace.cpp:2577-2578`.
   A browser substitute must be documented; whether a zeroed or synthetic blob is
   accepted by all validation paths is unverified.
4. **Packet version pin.** Non-gold builds default to `0x0A000060`
   (`Lan/NetLanDiscovery.cpp:31`); the gold constant is `0x0F000001`
   (`NetVersion.h:42`). The fixture must state which one is authoritative.
5. **StartRace unused slots.** The full 20-slot array is sent but only used slots are
   rewritten. Whether stale bytes are merely cosmetic or affect the receiver is
   unverified; `ProcessStartRace` reads the full struct and later loops on the count.
6. **Event subset for a normal race.** The list in §3.2 is derived from call sites,
   not from a captured race. Some events may never occur in a 1v1.
7. **1v1 peer path.** The expectation that JoinData carries no additional peers and
   InitialData is the only peer handshake in 1v1 is derived from the code, not
   observed.
8. **WASM network stack.** Whether the browser build talks to a JS DataChannel bridge
   or a compiled WebRTC library is undecided; the byte contract is independent of
   that choice, but the send/backpressure semantics are not.
9. **SCTP behaviour over TURN.** Message loss, fragmentation and latency have not been
   measured; the 1024-byte budget is a design constraint, not a measurement result.
10. **Respawn completeness.** No dedicated message exists; whether health + state is
    sufficient for every respawn case is unverified.

---

## 8. Source index

Primary files (all under `upstream/BlurRebuilt/code/`):

- `amax/library/Network/Misc/NetDatagramHeader.h:24-64`
- `amax/library/Network/Misc/NetDatagramPacketTypes.h:29-74`
- `amax/library/Network/Misc/NetEncrypted.h:25-28`
- `amax/library/Network/Misc/NetDefines.h:38-40,70-108,138`
- `amax/library/Network/Misc/NetRaceSettings.h:133-165`
- `amax/library/Network/Message/NetMessage.cpp:71-105,134-198,390-473,670-680`
- `amax/library/Network/Message/NetMessageReliableOutBox.cpp:178-180,213-220,244-272,290-320`
- `amax/library/Network/Message/NetMessageReliableInBox.cpp:74-123,142-189`
- `amax/library/Network/Router/NetRouterBase.cpp:189-268,503-593`
- `amax/library/Network/Core/NetServices.cpp:239-361`
- `amax/library/Network/Core/NetParty.cpp:292-302,1385,2878-2884,3090-3096`
- `amax/library/Network/Core/NetRace.cpp:329-384,400-566,568-1039,1110-1224,1337-1379,1577-1629,1768-1790,1933-1989,2432-2495,2498-2725`
- `amax/library/Network/Player/NetPlayer.cpp:119-191`
- `amax/library/Network/Player/NetPlayerManager.cpp:395-426`
- `amax/library/Network/Player/NetPlayerConnection.cpp:68-82`
- `amax/library/Network/Player/Data/NetPlayerRaceData.h:29-106`
- `amax/library/Network/Player/Data/NetPlayerProfileData.h:24-61`
- `amax/library/Network/Lan/NetLanDiscovery.cpp:30-32,139`
- `amax/library/Network/Lan/NetLanDiscoveryDefines.h:31-68`
- `amax/game/GameLogic/Structures/NetStartRacePacket.h:17-48`
- `amax/game/GameLogic/Structures/NetVehicleData.h:18-66`
- `amax/game/GameLogic/Structures/NetEventPackets.h:11-39`
- `amax/game/GameLogic/Structures/NetEventManager.cpp:139-151,166-220,280-345,599-623`
- `amax/game/GameLogic/GameModes/GameModeNetwork.cpp:393-459,480-538,612-670,762-856,990-1070`
- `amax/game/GameLogic/RaceModes/RaceModeMultiplayer.cpp:336-375,816-876,969-1006,1013-1104,1699-1749,1890-1916`
- `amax/game/GameLogic/Lua/lua_NetRace.cpp:1526-1604,1606-1649,2054-2103`
- `mercury/library/network/include/SystemProfile/SystemProfile.h:88-108`
- `mercury/library/common/core/include/core/Core.h:547`
- `mercury/library/common/core/include/btl/Containers/vector.h:34-120,830-853`
- `mercury/library/physics/racingphysics/include/racingphysics/Vehicles/vehicle.h:93-101`
- `mercury/library/network/include/network/Nonce.h:22-52`
- `vendor/demonware/2.0/bdCore/bdSocket/bdCommonAddr.h:34-49`
- `vendor/demonware/2.0/bdCore/bdContainers/bdBitBuffer.h:543-556`

Repository-level evidence used here:

- `tools/build_asset_probe.py:37` builds native with VS 2022 x64; `:48` builds wasm
  with `em++ -std=c++17 -O2` and no `-fshort-wchar`.
- Upstream working tree is clean at the commit above.

---

## 9. Handoff summary

- **First packet set:** KeepAlive, ACK, JoinRequest/JoinReply/JoinData, InitialData,
  PlayerStates, VehicleData, StartRace, BasicVehicleData (with event block),
  VehicleFinished. PostRace/Leaving follow immediately after.
- **Biggest ABI risk:** `wchar_t` inside `SysProfile::BaseProfile` (2 bytes under
  MSVC, 4 under default wasm32), embedded by value in join and StartRace packets and
  shifting every following field; the systemic version of the risk is raw struct
  `memcpy` with unpinned padding and bitfield allocation.
- **Next test:** the native/wasm layout probe — `sizeof`/`alignof`, `offsetof` for
  non-bitfields, and one-field-at-a-time bit patterns for the four header/vehicle
  bitfield types — before any fixture byte is frozen.
