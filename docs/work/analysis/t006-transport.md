# T-006c — WebRTC DataChannel transport feasibility and adapter design

**Date:** 2 November 2026
**Status:** design only. This document does not implement or claim a working
transport. No source, `upstream/`, game data or task card was modified; the game
was not run and no code was compiled for this document.
**Scope:** T-006c, the transport part of the browser multiplayer work described
in `docs/plan/multiplayer.md` ("Transport deneyi" and the WebRTC architecture
section). It answers one question: can the WinSock/UDP surface used by the LAN
race path be replaced by WebRTC DataChannel without changing the game protocol?
**Inputs:** `docs/plan/multiplayer.md`, `AGENTS.md`,
`docs/work/analysis/t005-streaming-design.md` (worker placement), and the
upstream sources cited inline.
**Method:** source reading only. Line numbers refer to the pinned upstream
checkout used by `docs/plan/multiplayer.md`
(`upstream/BlurRebuilt`, commit `5270304b81983b9e3edbd569ba25235c17bbabd7`).
External protocol statements are cited in section 8. Everything marked
**proposal** is a design decision, not an observation.

---

## 0. Summary

The engine's transport surface is narrower than it first appears. Above
`bdSocketRouter` the game uses only seven operations: `init`, `pump`, `connect`,
`disconnect`, `getStatus`, `sendTo`, `receiveFrom`, plus `getAddressMap`,
`getKeyMap`, `getLocalCommonAddr` and `isRelayEnabled`. `C_NetRouterBase`,
`C_NetMessageReliableOutBox/InBox`, `C_NetPlayerManager`, `C_NetRace` and
`C_NetParty` do not know about UDP, DTLS or NAT. That makes a transport backend
replacement feasible in principle.

It is not a drop-in socket substitution. The parts that do **not** survive a
naive port are:

1. **IP-address identity.** `bdCommonAddr` is a serialized set of local/public
   IPv4 addresses plus a NAT type (`bdCommonAddr.h:34-42, 78-90`). The engine
   copies that 25-byte blob through join messages and reconstructs peers with
   `bdCommonAddr::deserialize` (`NetRace.cpp:2573-2598`). A browser has no
   stable, meaningful IPv4 address to put there.
2. **Ordering.** The application reliable inbox accepts only the exact next
   sequence and acknowledges every packet, including one it did not accept
   (`NetMessageReliableInBox.cpp:85-123`). The current outbox is stop-and-wait:
   it sends only the head packet and does not send the next one until a matching
   ACK arrives (`NetMessageReliableOutBox.cpp:153-185, 290-321`). That happens to
   prevent reordering at the app layer today, but it is an implicit coupling,
   not a documented contract. Reliable traffic should use an ordered channel so
   the inbox does not depend on the outbox's current window.
3. **Blocking startup.** The offline PC path busy-waits on `bdNet` PENDING
   (`NetRouter_pc.cpp:456-458`) and enumerates Windows adapters with
   `GetAdaptersInfo` (`NetRouter_pc.cpp:357-408`). Neither is available or
   acceptable in a browser.
4. **LAN discovery.** `NetLanDiscovery` owns a broadcast `bdSocket` bound to UDP
   port 50001 and uses `sendTo(broadcast)` / `receiveFrom`
   (`NetLanDiscovery.cpp:53-56, 146-147, 195-208`). Browser JavaScript has no
   raw UDP or broadcast socket.

**Recommendation:** one `RTCPeerConnection` per engine association
(`bdEndpoint` = common address + security ID), with two negotiated DataChannels:

| Channel | DataChannel options | Carries |
|---|---|---|
| `reliable` | `ordered:true`, no `maxRetransmits` / `maxPacketLifeTime` | the bytes the engine currently sends through `C_NetMessageReliableOutBox` (join, initial data, vehicle setup, start/vote/disconnect) |
| `unreliable` | `ordered:false`, `maxRetransmits:0` | the bytes the engine currently sends through `C_NetRouterBase::SendMessage(C_NetMessage&)` (keepalive, ACKs, vehicle state, voice, lobby updates) |

Keep the application reliable/unreliable layers unchanged for the first slice.
Do not put the engine's unreliable traffic on a reliable DataChannel and do not
put its reliable traffic on an unordered channel. The app-level ACK/retry is
kept because callers and join state machines depend on it; SCTP reliability is
an additional lower layer, not a replacement yet. The cost is duplicate
transmission when an app ACK is lost; measure it before deciding whether to
remove the app ARQ later.

The first implementable slice is a **standalone browser adapter harness**, not
an engine build: WSS room service, two browser contexts, one peer connection,
two channels, sequenced test payloads, bounded queues and fault injection. The
engine wiring is the second slice, after the T-005a wasm gate and after a
`bdCommonAddr` identity decision.

---

## 1. Current transport surface

### 1.1 Call graph

The LAN path is:

```text
C_NetServices::Poll                       (NetServices.cpp:363-435)
  -> C_NetRouterPC::Poll                  (NetRouter_pc.cpp:218-278)
       -> C_NetRouterBase::Poll           (NetRouterBase.cpp:104-286)
            -> bdNet::getInstance()->getSocketRouter()
            -> bdSocketRouter::pump()      (NetRouterBase.cpp:149-153)
            -> bdSocketRouter::receiveFrom (NetRouterBase.cpp:188-189)
            -> listener dispatch           (NetRouterBase.cpp:212-268)
  -> C_NetPlayerManager::Poll             (NetPlayerManager.cpp:296-429)
       -> reliable outbox Poll            (NetPlayerManager.cpp:391-393)
       -> keepalive sends                 (NetPlayerManager.cpp:395-427)
  -> reliable inbox drain                 (NetServices.cpp:404-435)
```

Sends:

```text
C_NetPlayer::SendUnReliable
  -> C_NetRouterBase::SendMessage(C_NetMessage&, addr)
     -> status == BD_SOCKET_CONNECTED
     -> bdSocketRouter::sendTo(addr, data, size)

C_NetMessageReliableOutBox::Poll
  -> C_NetRouterBase::SendMessage(U8*, size, addr)
     -> status == BD_SOCKET_CONNECTED
     -> bdSocketRouter::sendTo(addr, data, size)
```

`NetRouterBase.cpp:503-556` and `:558-593` are the only two send paths.
`NetRouterBase.cpp:518-520` and `:573-575` refuse to send unless the association
status is `BD_SOCKET_CONNECTED`.

### 1.2 `bdSocket` and WinSock semantics

`NetLanDiscovery` is the only game-level owner of a raw `bdSocket`
(`NetLanDiscovery.h:107`). It calls `create(false, true)` — non-blocking,
broadcast — then `bind(Any, AMAX_LAN_DISCOVERY_PORT)` and later
`sendTo`/`receiveFrom` (`NetLanDiscovery.cpp:53-56, 146-147, 195-208`).
The PC port is 50001 (`NetLanDiscoveryDefines.h:31-33`).

On Windows, `bdSocket` is a thin wrapper over `bdPlatformSocket`:

- `create` makes `AF_INET/SOCK_DGRAM/IPPROTO_UDP`, sets `SO_BROADCAST` when
  requested, and uses `ioctlsocket(FIONBIO)` for non-blocking mode
  (`bdPlatformSocket-win32.cpp:49-99`).
- `bind` maps `WSAEACCES/WSAEADDRINUSE/WSAEADDRNOTAVAIL` to
  `BD_NET_ADDRESS_IN_USE` (`:101-136`).
- `sendTo` maps `WSAEWOULDBLOCK` to `BD_NET_WOULD_BLOCK`, `WSAEMSGSIZE` to
  `BD_NET_MSG_SIZE`, reset/timeout/unreachable errors to
  `BD_NET_CONNECTION_RESET`, and everything else to `BD_NET_ERROR`
  (`:139-203`).
- `receiveFrom` maps the same families; no data returns
  `BD_NET_WOULD_BLOCK` (`:205-275`).

The status codes are listed in `bdPlatformSocket.h:23-65`. The important
semantic is that a UDP send is fire-and-forget: a positive return means the
datagram was handed to the OS, not delivered. The engine already treats it that
way (`NetRouterBase.cpp:545-551` only checks `sent == dataSize`).

`bdSocket::getHandle()` returns an integer handle and `NetLanDiscovery` uses
`BD_INVALID_SOCKET_HANDLE` as the "closed" sentinel
(`bdSocket.h:87`, `NetLanDiscovery.cpp:82-83, 200-201`). A web discovery backend
must not return a fake live handle for a socket it does not own; it should keep
its own state and leave the raw-socket path out of the web build.

`bdNetImpl::start` also creates a non-blocking UDP socket, binds a free port and
constructs the local common address (`bdNet.cpp:51-64, 124-147`). This is true
even in offline/LAN mode; the LAN path is not socket-free. A browser therefore
cannot keep `bdNet` as-is and merely swap the discovery packet.

### 1.3 `bdSocketRouter` semantics

`bdSocketRouter` is described as a "NAT traversed & encrypted socket-like API"
(`bdSocketRouter.h:9, 50-59`). The engine uses these operations:

- `init(socket, localCommonAddr, config)` (`bdSocketRouter.h:91-93`);
- `pump()` every frame (`:95-97`);
- `connect(handle)` starts an **asynchronous** association setup; status is
  polled, not waited (`:107-123`);
- `disconnect(handle)` starts teardown (`:125-131`);
- `getStatus(handle)` returns `BD_SOCKET_IDLE`, `BD_SOCKET_PENDING`,
  `BD_SOCKET_CONNECTED` or `BD_SOCKET_LOST` (`:133-136`);
- `sendTo(handle, data, length)` returns bytes queued or a negative
  `bdSocketStatusCode` (`:142-160`);
- `receiveFrom(handle&, data, size, didErrorOccur)` returns bytes received or a
  negative status (`:162-184`);
- `getAddressMap()`, `getKeyMap()`, `getLocalCommonAddr()`,
  `isRelayEnabled()` (`:250-276`).

`receiveFrom` internally loops until the raw socket returns "would block"
(`bdSocketRouter.cpp:488-507`). `pump` drives NAT/DTLS associations and removes
lost ones (`:100-158`). `connect` is asynchronous and returns `true` when the
setup process *started*, not when it completed (`:212-311`). `getStatus` maps
the `bdAddrHandle` state and the DTLS association state to the four-value enum
(`:354-426`).

The router's `sendTo`/`receiveFrom` payload is the exact byte buffer that the
game protocol wrote. `bdSocketRouter.h:149-157` documents that the first two
bytes carry the encrypted-length field; that field is already part of
`DatagramPacketHeader.m_EncryptedBytes`
(`NetDatagramHeader.h:24-34`). The router does not add or remove a game-level
header. This is the property the WebRTC adapter must preserve: **the bytes
passed to `sendTo` are the bytes delivered to `receiveFrom`.**

### 1.4 Router poll, send and connected state

`C_NetRouterBase::Poll` only runs when `bdNet` is `BD_NET_DONE`
(`NetRouterBase.cpp:124-126`). It then:

- updates bandwidth counters (`:111-121`; note `TrackIncomingBytes` and
  `TrackOutgoingBytes` are empty at `:637-649`, so these counters currently
  measure nothing);
- calls `router->pump()` (`:149-153`);
- calls `router->receiveFrom` in a `do/while` until no more data (`:171-189,
  274`);
- parses `DatagramPacketHeader`, dispatches reliable packets, ACK packets and
  unreliable packets to listeners (`:212-268`).

There is no receive budget. A single `Poll` drains every queued datagram. The
`bError` out-parameter from `receiveFrom` is declared (`:188-189`) and never
read. A transport error is therefore silent at this layer; liveness is detected
by the game keepalive timers instead (`NetDefines.h:77-87`,
`NetPlayerConnection.cpp:68-82`).

`SendMessage` requires a non-null address, `BD_SOCKET_CONNECTED`, a terminated
unreliable message with a valid header, and then calls `sendTo`
(`NetRouterBase.cpp:503-556`). The raw overload does the same without message
validation (`:558-593`). `Disconnect` calls `socketRouter->disconnect(addr)`
(`:288-304`).

`C_NetServices::Poll` is called once per frame, takes a `TryEnter` lock, drives
the router and player manager, then drains the reliable inbox in a `do/while`
loop until no peer has a complete message (`NetServices.cpp:363-435`). Join
replies are special: they are reliable on the wire but are not inserted into the
inbox, so the receiver sends the acknowledgement manually
(`NetServices.cpp:292-321`).

### 1.5 LAN discovery

`C_LanDiscoveryManager` is both the advertiser and the enumerator
(`NetLanDiscovery.h:36-124`):

- `Initialise` creates a non-blocking broadcast socket and binds port 50001
  (`NetLanDiscovery.cpp:47-69`).
- `Advertise` stores the host profile, `SessionSecurity`, the host's serialized
  common address, slot counts and race QoS (`:86-103`).
- `Enumerate` builds a `LanDiscoveryRequest` with a nonce and sends it to
  `bdInetAddr::Broadcast()` (`:119-153`).
- `Poll` receives requests and replies, filters by title ID and packet size,
  answers requests with `LanDiscoveryReply`, and collects replies whose nonce
  matches (`:195-283`).
- Enumeration stops after 2 seconds (`:274-281`).

`LanDiscoveryHeader` carries packet version, title ID, packet type and nonce;
`LanDiscoveryReply` additionally carries console ID, host profile, session
security, the 25-byte host common address, slot counts and race QoS
(`NetLanDiscoveryDefines.h:43-68`). The Lua session browser reads that reply and
checks only the packet version before joining
(`lua_NetRace.cpp:373-394`).

The host advertises from `C_NetRace::AdvertiseLanGame`
(`NetRace.cpp:2265-2294`). The joining client passes
`serverData.m_SessionSecurity`, `m_HostCommonAddress` and `m_ConsoleId` into
`JoinLanSession` (`lua_NetRace.cpp:389`), which registers the session key and
starts `JoinStart` (`NetRace.cpp:329-364`).

### 1.6 Address and handle semantics

The transport identity is `bdEndpoint`: a `bdCommonAddrRef` plus a
`bdSecurityID` (`bdEndpoint.h:21-35`). `bdAddressMap::getAddrHandle(ca, id,
handle)` creates or finds the handle (`bdAddressMap.h:31-45`). A
`bdAddrHandle` stores that endpoint, a real address and a status
(`bdAddrHandle.h:103-123`).

`bdCommonAddr` is 25 bytes when serialized on PC:
`(BD_MAX_LOCAL_ADDRS + 1) * BD_ADDR_SIZE + 1`, with three local IPv4 addresses,
one public IPv4 address and a NAT-type byte (`bdCommonAddr.h:34-42`).
`BD_ADDR_SIZE` is IPv4 plus port (`bdAddr.h:22`). The engine serializes this
blob into join messages and deserializes it on the peer
(`NetRace.cpp:2573-2598`); the same blob is what LAN discovery advertises
(`NetRace.cpp:2294`).

The security ID is 8 bytes (`bdSecurityID.h:17`) and the session key is 16 bytes
(`bdSecurityKey.h:16`); `SessionSecurity` bundles them (`Securekey.h:34-47`).
On LAN these values are broadcast in the clear by design
(`NetLanDiscoveryDefines.h:59-68`); they are association metadata, not a
confidentiality guarantee.

`NetPlayerConnection::IsConnected` treats the handle's association status as
the peer's connected state, and `CanMessage` additionally requires the game
handshake to be complete (`NetPlayerConnection.cpp:35-60`). `JoinStart` creates
a remote `bdCommonAddr`, obtains a handle and calls `connect`
(`NetJoinHelper.cpp:246-264`); `JoinTimedOut` treats `BD_SOCKET_IDLE` and
`BD_SOCKET_LOST` as immediate failure (`:302-322`).

### 1.7 Reliability and ordering contract — the key finding

The engine has its own reliable transport on top of the datagram layer:

- `C_NetMessageReliableOutBox` splits a message into 1024-byte data packets,
  adds a 10-byte `DatagramReliablePacketHeader`, assigns a 16-bit sequence per
  party/race channel, and sends only the head packet. It retransmits every 0.5 s
  until an ACK for that sequence arrives (`NetMessageReliableOutBox.cpp:153-185,
  187-288, 290-321`).
- `C_NetMessageReliableInBox` accepts a packet only when its sequence equals
  `last + 1`, copies it, and then sends an acknowledgement — **even when the
  packet was not accepted** (`NetMessageReliableInBox.cpp:85-123`). It then
  reassembles a complete message when `m_BytesInInbox >= m_TotalMessageSize`
  (`:134-188`).
- The receive buffer is 6 KiB per player; the send buffer is 12 KiB per player
  (`NetDefines.h:95-99`, `NetPlayerManager.cpp:51-57`).
- `NetServices` dispatches reliable messages only after the inbox has a complete
  message (`NetServices.cpp:404-435`).

The inbox's "ACK even if not expected" behavior is intentional for duplicates,
but it also means the inbox has **no tolerance for reordering**: an unexpected
future packet is discarded and ACKed. The current outbox is stop-and-wait — it
sends only the head packet and waits for a matching ACK before sending the next
— so N+1 is not put on the wire before N has been received and ACKed. That is
why the current implementation works, but the guarantee is in the sender's
window policy, not in the inbox contract. If the outbox ever sends a window, or
if an ACK arrives from a stale/duplicate association, the inbox can discard a
future packet and the sender can remove it on the ACK.

The safe design contract is therefore:

> The engine's reliable byte stream must travel over an **ordered** channel.
> Unordered delivery is only safe for traffic that the engine already treats as
> unreliable. Do not make the inbox depend on the outbox remaining stop-and-wait.

A direct inbox test with deliberately reordered packets is still useful: it
should show the latent failure and document why the ordered channel is required.
It is not evidence that the current outbox reorders in normal operation.

A second, smaller finding: some reliable messages bypass the inbox. Join
replies are parsed directly and ACKed manually (`NetServices.cpp:292-321`), so a
lost manual ACK causes the outbox to retransmit the join reply. On an SCTP
reliable channel that retransmission is delivered again as a duplicate. The
join-reply handlers are guarded by state (`NetRace.cpp:1125-1138`), so this is
probably tolerable, but it must be tested rather than assumed. Vehicle data and
other reliable messages that do use the inbox are deduplicated by sequence.

### 1.8 What the browser cannot preserve

| Native property | Browser/WebRTC | Consequence |
|---|---|---|
| Raw UDP socket, `sendto`/`recvfrom` | No JavaScript raw UDP; WebRTC DataChannel is SCTP over DTLS over UDP | The transport is a channel, not a socket. Per-datagram destination is the channel's peer. |
| Broadcast to a LAN | No broadcast; WebRTC needs signaling | Discovery must become a room service. |
| IPv4 address as identity | No stable public IPv4; host candidates may be mDNS-obfuscated | `bdCommonAddr` needs an opaque web representation. |
| Immediate OS error for an unreachable peer | DataChannel `send` queues; failure appears later as `close`/`error`/state change | `sendTo` success means "queued", as with UDP, but errors are delayed differently. |
| Datagram size up to 1288 bytes (`bdSocketConfig.h:28`) | SCTP message size negotiated; 64 KiB default, most browsers ≥256 KB | The engine's 1024/5 KiB messages fit; do not grow them. |
| OS-level UDP buffering | `bufferedAmount` + SCTP congestion control | Need explicit caps and drop/refuse policy. |
| Blocking `bind`/adapter enumeration | WebRTC is asynchronous; no adapter list | Startup must be event-driven. |

---

## 2. WebRTC DataChannel options

### 2.1 Ordered/unordered and reliable/partially reliable

`RTCDataChannel` is message-oriented: one `send()` produces one message, and
SCTP preserves message boundaries. The relevant options are:

- `ordered` defaults to `true` (MDN, `RTCDataChannel.ordered`). Ordered reliable
  delivery is the default when neither `maxRetransmits` nor
  `maxPacketLifeTime` is set.
- `maxRetransmits` limits retransmissions; `0` requests no retransmission.
  `maxPacketLifeTime` limits the time the transport may spend. They are
  mutually exclusive. A channel with either set is "partially reliable".
- `ordered:false` allows out-of-order delivery. It does **not** by itself make
  the channel unreliable; it must be combined with `maxRetransmits:0` or
  `maxPacketLifeTime`.

The proposed mapping is deliberately conservative:

```text
reliable:   { ordered: true,  negotiated: true, id: 0 }
unreliable: { ordered: false, maxRetransmits: 0, negotiated: true, id: 1 }
```

`negotiated:true` with fixed IDs avoids the Data Channel Establishment Protocol
race and guarantees that both sides create the same channel configuration. Both
peers must create the channels; the SDP still negotiates the SCTP association
(`negotiated` only suppresses in-band channel announcement).

The exact behavior of `maxRetransmits:0` must be verified in every target
browser. The spec defines it, but partial-reliability implementations have
historically differed. The test in section 4.3 is the gate.

There is a second, testable choice for the unreliable channel:
`ordered:true, maxRetransmits:0`. That preserves the order of messages that are
delivered while still abandoning lost ones. It can avoid an older lobby/vote
update overwriting a newer one, but it may add head-of-line delay while a lost
message is abandoned. The first slice should use `ordered:false` because it is
the closest analogue to UDP; the ordered-unreliable variant is a measured
alternative if reordering turns out to break a specific message type. A
`maxPacketLifeTime` value (for example 100–200 ms) is a third option for stale
vehicle state, but it is not needed for the first slice.

### 2.2 Maximum message size

RFC 8841 defines the SDP `a=max-message-size` attribute. Each endpoint declares
the largest SCTP user message it will accept; if absent, the default is 64 KiB;
zero means "any size subject to memory" (`RFC 8841 §6.1`). MDN notes that most
modern browsers support at least 256 KB, but warns that large messages can cause
head-of-line blocking when SCTP message interleaving (RFC 8260) is unavailable
(`Using data channels`, "Understanding message size limits").

The engine does not need large messages:

- `NET_MAX_DATAGRAM_SIZE` is 1024 bytes (`NetDefines.h:40`).
- The reliable outbox splits at 1024 bytes of payload plus header
  (`NetMessageReliableOutBox.cpp:213-220`).
- `C_NetServices` allocates a 5 KiB message buffer
  (`NetServices.cpp:721`), which caps any single unreliable message the game can
  create.

The adapter should therefore reject anything above a fixed local limit
(proposal: 16 KiB) with `BD_NET_MSG_SIZE` rather than relying on browser
fragmentation. The game's own 5 KiB cap remains the protocol limit. No change to
`NET_MAX_DATAGRAM_SIZE` is justified by WebRTC.

### 2.3 `bufferedAmount`, backpressure and queue limits

`bufferedAmount` is the number of application bytes queued to be sent on that
channel (MDN, `RTCDataChannel.bufferedAmount`). It does not measure bytes already
on the wire or in the peer's receive buffer. `bufferedAmountLowThreshold` and
the `bufferedamountlow` event provide a low-water notification (MDN).

`send()` can throw:

- `InvalidStateError` if the channel is still `connecting`;
- `OperationError` if the data would need buffering and there is no room;
- `TypeError` if the message is too large for the peer
  (MDN, `RTCDataChannel.send()`).

There is no way to block until the buffer drains, and blocking the engine worker
is forbidden. The adapter therefore needs an explicit policy:

| Situation | Reliable channel | Unreliable channel |
|---|---|---|
| channel not `open` | return `BD_NET_NOT_CONNECTED`; outbox retries | return `BD_NET_NOT_CONNECTED`; caller drops |
| `bufferedAmount + len > cap` | return `BD_NET_WOULD_BLOCK`; outbox retries | return `BD_NET_WOULD_BLOCK`; count as a local drop |
| `send()` throws `OperationError` | map to `BD_NET_WOULD_BLOCK` | map to `BD_NET_WOULD_BLOCK` |
| `send()` throws `TypeError` | map to `BD_NET_MSG_SIZE`; log once | same |
| inbound queue full | **fatal**: close the association, status `LOST` | drop oldest, count, continue |

A proposal for the first slice is 64 KiB per channel send cap and
`bufferedAmountLowThreshold = cap / 4`. The engine's per-player outbox is only
12 KiB (`NetDefines.h:99`), so 64 KiB leaves room for a burst without building a
large hidden queue. The cap is a policy, not a measured optimum; section 4.5
must tune it.

The important negative rule: **do not build an unbounded JavaScript send queue
in front of the DataChannel.** If `send()` cannot accept the bytes, return the
negative status to the engine and let its own outbox/timer decide what to do.
That is the closest analogue to UDP `EWOULDBLOCK`.

On the receive side, the engine's inbox is only 6 KiB per player
(`NetDefines.h:96`). A large adapter queue is therefore not useful; it only hides
a frame stall. A bounded per-peer queue is needed so a remote peer cannot grow
memory without limit.

### 2.4 Signaling and room service

WebRTC cannot connect without out-of-band signaling. The room service is part of
the design, not an optional extra:

- WSS (HTTPS) service with room create/join, a short room code, a separate
  random join secret, roster and version/data hash.
- Relays SDP offers/answers and trickled ICE candidates between room members.
  It does not carry game traffic.
- Assigns a stable room-scoped `peerToken` per member and binds it to the
  member's DTLS fingerprint for the lifetime of the room.
- Enforces room size, TTL, rate limits and version match. The existing LAN check
  only compares `NET_PACKET_VERSION` (`lua_NetRace.cpp:387`); a browser service
  should also compare the build/data hash to avoid joining an incompatible
  client.
- Keeps host advertisement data opaque. The existing
  `LanDiscoveryReply`/`NetRaceSettingsQos`/`SysProfile::BaseProfile` bytes can
  be relayed without the service parsing game structs; this avoids a second
  serializer and keeps native/wasm layout risk in one place.

The service is trusted for room membership and SDP relay. It can substitute SDP
if compromised; end-to-end identity would require the game to sign its DTLS
fingerprint with an account key. That is out of scope for the first slice and
must be stated in the threat model.

### 2.5 STUN/TURN

ICE (`RFC 8445`) gathers host, server-reflexive and relayed candidates. Same-LAN
connections should use host candidates; different networks need STUN for
server-reflexive candidates, and TURN (`RFC 8656`) when direct connectivity
fails. TURN is the only guaranteed relay path; it forwards DTLS/SCTP without
seeing plaintext game data, but it does consume relay bandwidth and adds
latency.

Design requirements:

- Room service supplies a list of STUN and TURN URLs and short-lived TURN
  credentials. Do not ship a static TURN secret in the client.
- Support TURN over UDP, TCP and TLS on 443 for restrictive networks.
- Use trickle ICE; buffer remote candidates until the remote description is set.
- Use `pc.restartIce()` for a transient network change; treat `failed` as
  terminal and rejoin at the game layer.
- For the different-network acceptance test, force `iceTransportPolicy:'relay'`
  and assert from `getStats()` that the selected candidate pair is `relay`. A
  successful connection alone does not prove TURN is used.

Same-LAN tests must account for browser host-candidate obfuscation (mDNS
`.local` candidates). If mDNS is blocked, the same-LAN case can fall back to
STUN/TURN; that must be recorded, not silently treated as direct.

### 2.6 Trust and security

- All DataChannel traffic is DTLS-encrypted by WebRTC. The legacy
  `SessionSecurity` key is not needed for confidentiality and must not be
  described as providing it.
- The session key still flows through the engine's key map and key tracker
  (`NetRace.cpp:275-277, 346-353`). The web router should keep the map and honor
  `unregisterKey` by tearing down associations that use that security ID, so
  migration/cleanup semantics do not change (`NetSessionKeyTracker.cpp:120-139`).
- Signaling must be WSS and authenticated; the room code is a lookup key, not an
  authorization secret.
- The server must not log SDP, ICE credentials, session keys or profile blobs.
- Do not reuse the LAN discovery broadcast payload as a security boundary; it
  was never one.

### 2.7 Transport risks specific to DataChannel

DataChannel unreliable mode is SCTP with partial reliability, not UDP. SCTP still
has congestion control and can buffer; without message interleaving, a large
message on one channel can delay another (MDN). For a racing game this matters:
the engine sends vehicle state at roughly `NET_VEHICLE_UPDATE_TIME = 100 ms`
(`NetDefines.h:101-102`) and expects low latency, not reliable-stream behavior.

The design keeps reliable traffic low-volume (join/setup/events) and puts
high-frequency state on the unreliable channel, which is the best fit. It does
not prove that SCTP's congestion control meets race latency on a lossy WAN. That
is a measured gate (section 4.6), with a fallback discussion in section 7. The
source defines a 100 ms base interval between vehicle updates
(`NET_VEHICLE_UPDATE_TIME`, `NetDefines.h:101-102`); the actual send rate must be
measured from a native LAN trace.

---

## 3. Adapter mapping

### 3.1 Seam

**Proposal:** keep `C_NetRouterBase` and everything above it unchanged. Add a
`PLATFORM_WEB` implementation of the existing `bdSocketRouter` public surface
and a `PLATFORM_WEB` `bdNetImpl` startup that does not create a UDP socket.
Native Windows keeps the existing implementations.

Why this seam:

- Only a small set of direct `getSocketRouter()` references exist in
  `code/amax` (fewer than two dozen, including the
  `getKeyMap()`/`getAddressMap()`/`getStatus()`/`connect()`/`disconnect()`
  calls). The rest of the game talks to `C_NetRouterBase`.
- `bdSocketRouter` is already the abstraction the engine uses for NAT traversal,
  DTLS and association status. Replacing its backend is smaller than inventing a
  new router interface and changing `bdNetImpl`, `bdConnectionStore` and every
  caller.
- The game protocol above it remains byte-identical.

The web backend still needs these `bdSocketRouter` methods:
`init`, `pump`, `connect`, `disconnect`, `getStatus(handle)`, `sendTo`,
`receiveFrom`, `getAddressMap`, `getKeyMap`, `getLocalCommonAddr`,
`isRelayEnabled`. It does not need QoS probing, relay routing or DTLS internals.
The header must be platform-gated so the web build does not compile the DTLS/NAT
members. This is a shared-file change and must be owned by the main agent, not a
subagent.

An alternative is a new virtual interface above `bdSocketRouter`. It is cleaner
long-term but touches more shared files and vendor code; it is not recommended
for the first slice.

### 3.2 Peer identity

**Proposal:** on web, `bdCommonAddr` carries a 25-byte **opaque peer record**
instead of IPv4 addresses. A suggested layout, to be fixed by a format contract
and golden tests, is:

```text
byte 0       format/version discriminator (web peer record)
bytes 1..16  128-bit room-scoped peerToken
bytes 17..24 8-byte session/association tag (reserved for the security ID or a
             per-association random value)
```

This fits `BD_COMMON_ADDR_SERIALIZED_SIZE` exactly (25 bytes on PC,
`bdCommonAddr.h:34-42`) without changing the join message sizes. The web
`bdCommonAddr` must:

- hash the whole 25-byte record in `getHash()` (the native implementation hashes
  addresses, `bdCommonAddr.h:125-127`);
- compare the record in `operator==`/`operator<`;
- treat loopback as "token equals the local token" (`isLoopback`);
- implement `serialize`/`deserialize` for the opaque record;
- make `getPublicAddr`/`getLocalAddrs` unavailable or return sentinel values,
  and ensure no game code depends on them. In the inspected Network sources,
  only router logging uses them.

`bdEndpoint` (`common addr + security ID`) remains the association key. This
preserves `bdAddressMap` and `bdAddrHandle` behavior: one handle per
`(peerToken, securityID)` pair, the same handle returned on receive, and
`disconnect` invalidates it. `getRealAddr()` becomes meaningless; the web
implementation should return a sentinel and never expose it to game logic.

Do **not** fabricate IPv4 addresses or a NAT type in the 25 bytes. That would
make `deserialize`, hashing and the join payload silently wrong. The format must
be explicit and versioned; native and wasm must agree on the 25-byte layout.
Native and web clients cannot cross-join unless a translator exists; the web
record must be rejected by the native discovery/join path rather than parsed as
an address.

`peerToken` should be stable for the room session. A transport reconnect gets a
new **epoch** while keeping the token; the adapter must flush the old epoch so
stale packets cannot be delivered after the game resets its sequence counters.
If the game treats the reconnect as a new join, the token may remain the same
but the transport handle must be recreated.

### 3.3 Channels

One `RTCPeerConnection` per `bdEndpoint` (peer token + security ID):

```text
PC(peerToken, secID)
  ├── DataChannel id 0, label "blur/rel/1", ordered, reliable
  └── DataChannel id 1, label "blur/unrel/1", unordered, maxRetransmits 0
```

If the party and race sessions use the same common address but different
security IDs, they get separate PCs. If they use the same endpoint, they share
one PC and one pair of channels; the engine's datagram header already carries
the party/game bit (`DatagramPacketHeader.m_PartyChannel`,
`NetDatagramHeader.h:30-33`), so one pair of channels is sufficient per endpoint.

The `receiveFrom` source handle is the endpoint's handle. The adapter keeps
per-endpoint inbound queues for both channels; `receiveFrom` drains the reliable
queue first, then the unreliable queue, so low-volume control traffic is not
delayed behind a state burst. Ordering within the reliable channel is preserved
by SCTP; ordering across the two channels is not guaranteed, just as ordering
across UDP datagrams is not.

DataChannel labels are local metadata; they are not part of the game wire format.
Do not add an adapter header to the payload. If diagnostics need a sequence
number, put it in the test payload, not in production packets.

The router selects the channel from the game's own header, not from a new API:
both send paths pass a buffer that starts with a `DatagramPacketHeader`, whose
bitfield word contains `m_Reliable` (`NetDatagramHeader.h:24-34`). A set bit
means the reliable channel; a clear bit means the unreliable channel. This also
sends acknowledgements (which are unreliable by construction,
`NetDatagramHeader.h:58-64`) on the correct channel. `sendTo` must check that
the buffer is at least `sizeof(DatagramPacketHeader)` before reading the bit;
short buffers return `BD_NET_MSG_SIZE`. This makes the channel selector one more
consumer of the datagram header layout; the T-006b wire-format golden test must
cover the `m_Reliable` bit on native and wasm, not just the message body.

### 3.4 Connection state mapping

`bdSocketRouter::getStatus(handle)` must reflect the association, not the
browser's peer connection alone. A PC can be `connected` while a DataChannel is
still `connecting`; sending then would lose data.

| Engine status | Web condition |
|---|---|
| `BD_SOCKET_IDLE` | no association exists for this handle, or the PC is `new` before `connect()` |
| `BD_SOCKET_PENDING` | PC `connecting`, ICE `checking`, channel `connecting`; or PC `disconnected` within the recovery grace |
| `BD_SOCKET_CONNECTED` | PC `connected` **and** both required channels `open` |
| `BD_SOCKET_LOST` | PC `failed`/`closed`, channel `closed`, `disconnect()` completed, or `disconnected` past the grace |

Rules:

- `connect(handle)` returns `true` only if it actually started negotiation for a
  known peer; duplicate calls return `true` without creating a second PC.
- `getStatus` is cheap and cached; it must not call `getStats()`.
- Do not return `CONNECTED` until the reliable channel is open. The unreliable
  channel must also be open before `CONNECTED`, otherwise the engine will send
  gameplay traffic into a non-existent channel.
- `disconnected` is not immediately `LOST`; ICE may recover. Use a short grace
  (proposal: 2 seconds, measured against the engine's keepalive timers) and then
  `LOST`. `failed` is terminal for that epoch.
- `LOST` is final for the epoch. A reconnect creates a new epoch and requires
  the game join path to run again unless the same SCTP association survived an
  ICE restart.

`C_NetRouterBase::m_PlatformConnectionState` is about the platform/service
connection (`NetRouterDefines.h:22-28`), not peer liveness. Do not conflate the
two. The web `bdNet` backend can report `eConnectionStateComplete` immediately
for the offline path; peer status comes from the router.

### 3.5 Error semantics

`NetRouterBase` ignores the `didErrorOccur` flag and only checks positive byte
counts (`NetRouterBase.cpp:188-189, 207-274`). The adapter should still map
errors correctly and log them rate-limited; it must not throw across the
wasm/JS boundary.

| Native status | WebRTC cause | Adapter result |
|---|---|---|
| `BD_NET_SUCCESS` | `send()` queued / bytes copied | positive byte count |
| `BD_NET_WOULD_BLOCK` | channel buffer full, or no inbound message | `-2` |
| `BD_NET_NOT_CONNECTED` | channel/PC not open | `-11` |
| `BD_NET_CONNECTION_RESET` | channel/PC closed or failed | `-5` |
| `BD_NET_MSG_SIZE` | message over local/SDP limit, or `TypeError` | `-6` |
| `BD_NET_ADDRESS_INVALID` | unknown peer token / malformed handle | `-7` |
| `BD_NET_INVALID_HANDLE` | handle not in the web association table | `-10` |
| `BD_NET_ERROR` | unexpected `send()`/API exception | `-1` |

`sendTo` returning a positive count means "queued", exactly like UDP. It does
not mean the peer received it. `receiveFrom` returns one message per call and
`BD_NET_WOULD_BLOCK` when the queue is empty; `NetRouterBase`'s outer loop will
call it again next frame.

`send()` exceptions must be caught in the JS boundary function; an uncaught
`DOMException` would cross into wasm as an abort, not a negative status.

### 3.6 Queues and budgets

Proposed limits for the first slice (all configurable, all reported in stats):

| Queue | Limit | Overflow policy |
|---|---|---|
| per-endpoint reliable inbound | 64 messages / 128 KiB | fatal: close association, status `LOST` |
| per-endpoint unreliable inbound | 128 messages / 128 KiB | drop oldest, increment counter |
| per-channel send (`bufferedAmount`) | 64 KiB | return `BD_NET_WOULD_BLOCK`; no JS queue |
| `receiveFrom` per `pump` | 64 messages | return `BD_NET_WOULD_BLOCK`, resume next frame |
| `C_NetServices` reliable inbox per frame | 64 complete messages | leave the rest for next frame |
| global inbound across peers | 4 MiB (proposal) | apply per-peer policy, log |

Why reliable overflow is fatal rather than a drop: the app-level ARQ's inbox
cannot tolerate an arbitrary gap (section 1.7). Silently dropping a reliable
message would produce the exact out-of-order ACK bug the app layer cannot
recover from. Closing the association makes the failure visible and lets the
game's join/dropout path handle it.

Why unreliable overflow drops the oldest: vehicle state and voice are
time-sensitive; the newest sample is more useful than a stale backlog. The
engine already tolerates loss for these messages. ACKs and keepalives also use
the unreliable channel; a dropped ACK causes an app retransmit, and a dropped
keepalive is replaced by the next one. Both are acceptable.

The existing `C_NetServices::Poll` reliable drain is unbounded
(`NetServices.cpp:404-435`). The web build must add a per-frame budget or the
adapter queue limit becomes the de facto budget. A flood of complete reliable
messages from one peer must not starve rendering or the rest of the game.

### 3.7 Main-loop integration

No blocking waits, no network thread that calls game code, no `Atomics.wait` for
transport:

1. Browser peer agent owns `RTCPeerConnection` and signaling. If
   `RTCPeerConnection` is available in a dedicated worker, run it in the engine
   worker. If not, run it on the main thread and transfer the `RTCDataChannel`
   to the engine worker (MDN states `RTCDataChannel` is transferable; this must
   be probed in the target browsers).
2. `message`/`open`/`close`/`error`/`bufferedamountlow` handlers only copy bytes
   and push events into bounded queues. They never call engine functions.
3. The engine worker calls `C_NetServices::Poll` once per frame. The web
   `bdSocketRouter::pump()` processes queued state events; `receiveFrom` pops at
   most the budget; `sendTo` checks channel state and `bufferedAmount`.

The C++/JS boundary can stay small:

```text
net_poll()                              drain state events only
net_connect(handle)                     start/attach a peer association
net_disconnect(handle)                  close the association (idempotent)
net_status(handle)                      return the cached four-value status
net_send(handle, channel, ptr, len)     copy out, send, return len or negative
net_recv(handle, dst, cap)              copy one datagram in, return bytes or negative
```

`net_send` must copy the wasm buffer before returning; do not rely on `send()`
retaining a view into wasm memory. `net_recv` copies into a caller-provided wasm
buffer so the JS ring can reuse its storage. `net_poll` must never call back into
game code; it only moves events between the JS queues and the C++ state table.
All six functions are non-blocking and return immediately.
4. Connect/disconnect are requests. `connect` starts negotiation and returns;
   status is polled. `disconnect` closes asynchronously and is idempotent.
5. Signaling WebSocket messages are handled as events; no synchronous XHR, no
   busy-wait for room join or ICE.
6. All game timing remains on the engine clock. JS `performance.now()` is for
   diagnostics and the short `disconnected` grace only.

The existing offline startup busy-wait (`NetRouter_pc.cpp:456-458`) is avoided
if the web `bdNetImpl::start` completes immediately: it creates the local opaque
identity and returns `BD_NET_DONE` without touching a socket. Peer connections
are established later by `connect(handle)`, which is already asynchronous. This
is preferable to changing `StartConnect` into a new state machine, but it must
be verified that no code assumes a real socket exists after `bdNet::start`.

The PC `GetAdaptersInfo` block (`NetRouter_pc.cpp:357-408`) must be excluded from
the web build; there is no adapter list. The web `bdNet` backend must not assert
on empty `m_localAddresses` (`bdNet.cpp:127`).

### 3.8 Reconnect semantics

Two cases must be distinguished:

1. **ICE restart / candidate switch.** RFC 8841 says candidate-pair changes,
   including roaming, do not create a new SCTP or DTLS association
   (`RFC 8841 §12.2`). The same DataChannels and the same app sequences survive.
   The adapter keeps status `PENDING` during the restart and returns
   `CONNECTED` when the channels are usable again. No app rejoin.
2. **PC failure/close.** The SCTP association is gone. The adapter flushes queues
   for that epoch, marks `LOST`, invalidates the handle, and requires the game
   to run its disconnect/join path again. Do not silently create a new PC and
   continue the old reliable sequence; the app inbox/outbox counters would be
   inconsistent.

The room service may re-offer a new PC for the same `peerToken` after a failure.
The game-level join (`C_NetJoinHelper`, `JoinStart`, `JoinTimedOut`) is the
authority for whether the session can continue. The existing keepalive timers
(4 s host dropout, 6 s peer dropout, `NetDefines.h:77-81`) remain the liveness
signal even if `getStatus` still says `CONNECTED`.

### 3.9 LAN discovery replacement

**Proposal:** keep `C_LanDiscoveryManager`'s public API and packet structs; replace
its transport with a room-service backend selected at compile time.

- `Advertise` sends the host's `LanDiscoveryReply` data (opaque) and updates it
  when slots/settings change.
- `Enumerate` asks the service for rooms (or a specific code) and receives the
  same `LanDiscoveryReply` bytes, with the service echoing the request nonce.
- `Poll` drains WebSocket events with the same 2-second enumeration window
  (`NetLanDiscovery.cpp:274-281`).
- No UDP port 50001, no broadcast, no `bdSocket`.
- The service filters by title/version/data hash; the client keeps the existing
  `NET_PACKET_VERSION` check (`lua_NetRace.cpp:387`).

This preserves the Lua/UI call sites (`NumEnumerated`,
`GetEnumeratedSesionData`, `Advertise`, `UnAdvertise`) and avoids a second
session-browser API. The service treats `SysProfile::BaseProfile`,
`NetRaceSettingsQos` and `SessionSecurity` as opaque bytes; it does not parse
them. That keeps the native/wasm struct-layout problem in the existing
serializer/wire-format task rather than duplicating it in JavaScript.

If the host advertisement is too large or its layout differs by compiler, the
existing plan's wire-format gate applies
(`docs/plan/multiplayer.md`, "Wire biçimi"). WebRTC does not remove that work.

### 3.10 Native parity

- Keep the native UDP path and the native LAN test as the reference.
- The web adapter must not change `DatagramPacketHeader`,
  `DatagramReliablePacketHeader` or `DatagramAcknowledgementHeader`
  (`NetDatagramHeader.h:24-64`).
- Every byte passed to `sendTo` on native must be the byte passed to
  `DataChannel.send` on web, and vice versa. Golden packets from native should be
  replayed through the web adapter.
- Do not "improve" the protocol because DataChannel allows larger messages.
- Keep `NET_MAX_DATAGRAM_SIZE = 1024` and the 5 KiB message buffer for parity.
- The web `getKeyMap()` can use the existing `bdSecurityKeyMap` for registration
  and unregistration, but it must implement the `unregisterKey` tear-down
  behavior (or an equivalent explicit disconnect) so key cleanup still works.

---

## 4. Required tests

These are transport tests, not a playable-race claim. All tests record browser
version, OS, selected ICE candidate pair and `getStats()` output.

### 4.1 Adapter unit and fault injection (no real network)

Use a fake channel/link that implements the same adapter contract and can drop,
duplicate, delay and reorder messages deterministically. This tests the adapter
logic without WebRTC timing noise:

- message sizes 0, 1, 1024, 16 KiB, over the local limit;
- `connecting`/`open`/`closing`/`closed` transitions;
- `send()` throwing `InvalidStateError`, `OperationError`, `TypeError`;
- send cap reached, then `bufferedamountlow` and resume;
- inbound reliable overflow → fatal `LOST`, no silent drop;
- inbound unreliable overflow → oldest dropped, counter increments;
- `receiveFrom` budget and empty-queue `BD_NET_WOULD_BLOCK`;
- duplicate and out-of-order delivery on the reliable path is rejected by the
  app inbox, not accepted by the adapter; duplicate ACKs are harmless;
- zero-length and truncated payloads are rejected without reading past the
  buffer.

This layer can run in Node or a browser without ICE and is the fastest regression
gate.

### 4.2 Two browser adapters, sequenced packets (same LAN)

Two independent browser contexts (Playwright or equivalent), one room, one PC:

- reliable channel: 10,000 packets of 1,024 bytes with `{seq, payload, crc32}`;
  assert exactly 0..N-1, no duplicates, no gaps, SHA-256 of the concatenation
  matches the sender;
- unreliable channel: 10,000 packets; assert every received sequence is in the
  sent set and no duplicates; record the observed loss and reorder distance
  (the deterministic injected-loss run is section 4.3);
- exactly one message per `send()` reaches `receiveFrom` (message boundaries);
- payload sizes around 1, 1024 and 5 KiB;
- clean teardown: close both contexts, no leaked PC/channel, no console errors
  or warnings.

This is the acceptance test the plan calls "Transport deneyi"
(`docs/plan/multiplayer.md`, gate 3).

### 4.3 Loss and reorder

Two levels are needed because the real reliable channel hides loss by design:

1. **Deterministic adapter test:** configure the fake unreliable link to drop
   5%, reorder 2% and duplicate 1%; configure the fake reliable link to inject
   delay and duplicates but no loss or reorder (that is what SCTP reliable
   ordered promises). Verify the adapter's counters and queue policies.
   Separately, feed deliberately reordered packets directly into a small
   `C_NetMessageReliableInBox` unit (or a faithful model of it) to demonstrate
   its latent order dependence: the unexpected future packet is discarded but
   ACKed. This is a contract test, not a claim that the current stop-and-wait
   outbox reorders in normal operation. Do not adopt an unordered channel for
   reliable traffic on the strength of the current sender window.
2. **Real WebRTC impairment:** run the two browsers through a controlled TURN
   relay with `tc netem` (Linux container) or an equivalent UDP impairment tool.
   For the reliable channel, assert the payload still arrives exactly once and
   in order, and measure the added latency/retransmit time. For the unreliable
   channel, measure loss, reorder distance and p95/p99 latency. On Windows,
   without a controllable relay, this case is manual/unverified; do not claim
   CI coverage.

The real test must distinguish "SCTP recovered" from "the app recovered". Both
are relevant; the app's ACK/retry still runs on top.

### 4.4 Reconnect

- `pc.close()`: adapter reports `LOST`, handle is invalid, no queued packet is
  delivered after the epoch change; a new room join creates a new PC and a new
  handle; the game join path succeeds.
- `pc.restartIce()` after a simulated interface change: same channels, same app
  sequence, no duplicate/loss; status goes `PENDING` and back to `CONNECTED`.
- Signaling socket drop/reconnect: existing PC survives; roster resyncs; no
  duplicate PC.
- Peer leaves: the other side sees `LOST`/keepalive timeout within the existing
  4/6 s budgets; the game removes the player exactly once.

Assert that stale packets from an old epoch cannot enter the new inbox, and that
`disconnect()` is idempotent.

### 4.5 Queue limits

- Fill the receive queue while the engine does not call `receiveFrom`; assert
  memory stays under the cap, reliable overflow is fatal, and unreliable
  overflow drops the oldest with a counter.
- Fill `bufferedAmount` with a fake/slow channel; assert `sendTo` returns
  `BD_NET_WOULD_BLOCK` and the adapter does not allocate an unbounded JS queue.
- Drain after the cap; assert the engine resumes without a stall.
- Soak for 60 s at the expected packet rate; assert queue high-water marks stay
  below the caps and the page remains responsive.

### 4.6 Same-LAN then different-network TURN

1. **Same LAN:** both browsers on one machine/LAN, no forced relay. Record the
   selected candidate pair; expect `host` (or `srflx` if mDNS is blocked). Run
   the 4.2 packet test and record RTT/throughput.
2. **Different network / forced relay:** configure
   `iceTransportPolicy:'relay'`, TURN over UDP and TLS 443. Assert from
   `getStats()` that the selected pair's local/remote candidate type is `relay`.
   Run the same packet test; record RTT, throughput, loss and CPU.
3. **TURN credential lifecycle:** expire/rotate credentials; assert new
   connections use fresh credentials and existing connections are not silently
   broken.
4. **NAT matrix:** a TURN-only run is a proxy for hard NAT, not proof for every
   NAT. Record the actual network topology; do not generalize.

The plan's gate 5 requires two browsers on the same machine/network first, then
separate networks (`docs/plan/multiplayer.md`). This section is the transport
subset of that gate.

### 4.7 Engine integration (after the first slice)

- Golden packet replay: native LAN join/vehicle packets replayed through the web
  adapter; byte-for-byte equality.
- `C_NetMessageReliableOutBox`/`InBox` round-trip over the adapter, including
  lost ACK, duplicate, and delayed ACK.
- Two wasm clients run `JoinLanSession` through the room-service discovery
  replacement; host/peer join states reach `eJoinStateComplete`; the existing
  error codes (`NetJoinErrors.h:23-41`) map to the new failures.
- Only after that: a real two-client race, with vehicle/pickup/damage/respawn/
  finish events compared.

### 4.8 Evidence to record

- JSON: packet counts, byte counts, hashes, loss/reorder counts, queue
  high-water marks, `bufferedAmount` maxima, RTT percentiles, selected candidate
  pair, browser/OS versions, TURN URL/protocol, pass/fail per criterion.
- Screenshot of the test report page and a clean console (AGENTS.md browser
  evidence rule).
- Logs under `_work/logs/`, verification JSON/screenshot under
  `_work/verification/`, referenced from the eventual task card/log. This
  document does not create those artifacts.

---

## 5. Minimal first slice and acceptance criteria

The first slice should not wait for the engine to compile to wasm. It should
prove the adapter and the room service with the exact byte/queue contract, then
wire the engine in a second slice.

### 5.1 Slice content

1. **WSS room service (minimum):** create/join one room with a short code,
   roster of two peers, version/data-hash check, SDP/ICE relay, TURN credential
   endpoint. No game data, no account system, no matchmaking.
2. **Browser peer agent:** one `RTCPeerConnection` per peer, negotiated reliable
   channel id 0 and unreliable channel id 1, trickle ICE, state/error events,
   `bufferedAmount` caps, bounded inbound queues, stats.
3. **Adapter contract:** a small TypeScript/JS module with
   `connect(peerToken, secID)`, `disconnect`, `status`, `send(channel, bytes)`,
   `receive(handle)`, `poll`, `stats`. This is the shape the C++ web backend will
   call later; it is not yet the C++ implementation.
4. **Test harness:** two independent browser contexts, sequenced/CRC payloads,
   fake-link fault injection, queue flood, reconnect, and a report page.
5. **Evidence:** 10,000 reliable packets exact, 10,000 unreliable packets within
   the injected bounds, queue caps enforced, reconnect works, console clean,
   screenshot captured.

Explicit non-goals for this slice: engine/wasm integration, DemonWare online,
LAN discovery UI, host migration, real race, voice, TURN production capacity.

### 5.2 Acceptance criteria

- Room create/join succeeds over WSS; the two contexts see each other; version
  mismatch is rejected with a distinct error.
- Reliable channel: 10,000 × 1,024 B delivered exactly once, in order, hash
  match; zero duplicates/gaps.
- Unreliable channel: in the deterministic harness, 10,000 packets with 5%
  injected loss and 2% reorder; every received packet is valid; no duplicates;
  counters match the injection. In the real WebRTC run, record the observed
  loss/reorder instead of claiming a fixed injection.
- Message boundaries preserved; 5 KiB payload accepted; over-limit payload
  rejected with `BD_NET_MSG_SIZE`, not a browser exception.
- Send cap: `bufferedAmount` never exceeds the configured cap; over-cap send
  returns `BD_NET_WOULD_BLOCK`; no unbounded JS queue; memory stays bounded in a
  60 s soak.
- Receive cap: reliable overflow closes the association and reports `LOST`;
  unreliable overflow drops oldest and increments a counter.
- `pc.close()` → `LOST`; a new join creates a new handle; no stale packet is
  delivered. `restartIce()` preserves the channel and sequence.
- No blocking call, no busy-wait, no `Atomics.wait`; the page remains responsive
  during connect and under load.
- Console has no errors or warnings; the test report screenshot is recorded.
- The harness records the selected candidate pair and `getStats()`; a
  TURN-forced run is a separate, clearly labelled case.

Passing this slice proves the adapter contract and the WebRTC channel choices.
It does not prove the engine integration, the join state machine, or a playable
race.

---

## 6. What remains unverified without a real two-client race

- **Actual packet mix and rate.** The design assumes vehicle state dominates the
  unreliable channel and reliable traffic is low-volume. Only a native LAN
  capture and a real race can confirm sizes, rates and burstiness.
- **SCTP latency under loss.** DataChannel's congestion control may add latency
  that UDP would not. The test plan measures it, but playability is a race-level
  judgement.
- **Join timing.** `C_NetJoinHelper` gives the join 15 s (30 s with peer routing)
  before `JoinTimedOut` (`NetDefines.h:70-75`, `NetJoinHelper.cpp:302-322`).
  Pre-connecting in the lobby is a proposal; only a real join proves ICE/TURN
  fits the budget.
- **Engine behavior.** `NetRace`/`NetParty` state machines, host coordination,
  peer lists and dropout handling are source-read, not runtime-verified. The
  host/peer authority model may differ from the assumption.
- **Reliable-on-reliable interaction.** Lost ACKs cause duplicate join replies,
  vehicle data and other reliable messages. State guards may make them
  idempotent; only a fault-injected engine run proves it.
- **Host migration.** The engine has migration messages and state
  (`NetMigrationStates.h`, `NetRace.cpp`), but no transport test covers a host
  leaving mid-race.
- **Event ordering.** Pickups, damage, abilities, respawn and finish are separate
  network components. Their reliability class and ordering requirements need a
  real race trace.
- **Voice.** The existing `Communicator`/voice path is platform audio, not this
  data transport. Whether voice should use WebRTC media, a DataChannel, or stay
  native is out of scope.
- **Browser/OS matrix.** Chrome/Edge/Firefox/Safari differences in
  `maxRetransmits:0`, mDNS candidates, TURN TLS, worker exposure of
  `RTCPeerConnection`, and channel transfer are unverified.
- **TURN capacity and cost.** Per-peer relay bandwidth for a full mesh, and
  behavior when a relay is saturated, are unmeasured.
- **Security/trust.** The signaling service can substitute SDP; there is no
  end-to-end identity proof in this design.
- **WASM boundary details.** Memory growth detaching views, copy cost of 1 KiB
  messages, and whether `RTCDataChannel` can be transferred to the engine worker
  in every target browser are unverified.

None of these can be replaced by the transport harness. A real two-client race
is still the only acceptance for multiplayer.

---

## 7. Blockers and decisions required

### 7.1 Hard blockers

1. **Engine wasm gate.** T-005a still blocks the engine from compiling to wasm
   (`docs/work/analysis/engine-wasm-probe.md`, `CURRENT.md`). T-006c can design
   and prototype the adapter, but cannot wire `bdSocketRouter` into the game
   until that gate clears.
2. **Peer identity format.** `bdCommonAddr` is IP-based and its 25-byte blob is
   copied through join messages (`NetRace.cpp:2573-2598`,
   `bdCommonAddr.h:34-42`). A web opaque record, hashing/equality and
   serialization contract must be decided and golden-tested. Without it, every
   join/LAN path carries meaningless addresses.
3. **Blocking and unbounded loops.** The offline `bdNet` start busy-waits
   (`NetRouter_pc.cpp:456-458`), `GetAdaptersInfo` is Win32-only
   (`:357-408`), `bdSocketRouter::receiveFrom` drains until empty
   (`bdSocketRouter.cpp:488-507`), and `C_NetServices` drains the reliable inbox
   without a budget (`NetServices.cpp:404-435`). The web backend must make
   startup asynchronous/immediate and add per-frame budgets.
4. **Router seam.** `bdSocketRouter` is a concrete class with DTLS/NAT internals
   (`bdSocketRouter.h:278-346`). A `PLATFORM_WEB` implementation or a virtual
   interface must be agreed; this touches shared/vendor headers and is not a
   subagent-owned change.
5. **Signaling and TURN infrastructure.** No room service, WSS endpoint, STUN or
   TURN server exists in the repository. Different-network play cannot be
   claimed without a deployed TURN path and credentials lifecycle.
6. **Ordering contract.** The reliable inbox accepts only the exact next
   sequence and ACKs packets it did not accept
   (`NetMessageReliableInBox.cpp:85-123`). The current outbox is stop-and-wait,
   so it happens to preserve order, but that coupling is not documented. Use an
   ordered reliable channel; any proposal to use an unordered channel for
   reliable traffic must either keep the stop-and-wait invariant or rewrite and
   test the inbox.

### 7.2 Decisions to take before implementation

- Opaque `bdCommonAddr` byte layout and whether the 8-byte tail is the security
  ID or a separate association tag.
- Whether the browser peer agent runs in the engine worker or on the main thread
  with a transferred DataChannel (capability probe first).
- Send/receive queue caps and the `disconnected` grace value; these need
  measurement, not guesses.
- Whether to keep the existing app ARQ indefinitely or, after measurement,
  remove it for reliable traffic and rely on SCTP. The first slice keeps it.
- Whether WebRTC DataChannel's SCTP behavior is acceptable for vehicle state; if
  not, evaluate WebTransport/QUIC datagrams or a WebSocket relay behind the same
  adapter contract. That is a fallback, not the first slice.

---

## 8. References

### 8.1 Upstream sources (relative to `upstream/BlurRebuilt`)

| Area | Path / lines |
|---|---|
| LAN discovery socket, broadcast, poll | `code/amax/library/Network/Lan/NetLanDiscovery.cpp:47-69, 119-153, 195-283` |
| LAN discovery structs and port | `code/amax/library/Network/Lan/NetLanDiscoveryDefines.h:31-33, 43-68` |
| Router base poll/send/disconnect | `code/amax/library/Network/Router/NetRouterBase.cpp:104-304, 503-593, 637-649` |
| Router base API | `code/amax/library/Network/Router/NetRouterBase.h:96-112, 200-246` |
| PC router startup/poll | `code/amax/library/Network/Router/NetRouter_pc.cpp:70-216, 218-278, 348-540, 854-889` |
| Datagram headers | `code/amax/library/Network/Misc/NetDatagramHeader.h:24-64` |
| Packet types | `code/amax/library/Network/Misc/NetDatagramPacketTypes.h:27-75` |
| Message API | `code/amax/library/Network/Message/NetMessage.cpp:71-216` |
| Reliable outbox | `code/amax/library/Network/Message/NetMessageReliableOutBox.cpp:153-185, 187-288, 290-321` |
| Reliable inbox | `code/amax/library/Network/Message/NetMessageReliableInBox.cpp:69-188` |
| Services poll/dispatch | `code/amax/library/Network/Core/NetServices.cpp:283-361, 363-435, 721` |
| Player manager queues/keepalive | `code/amax/library/Network/Player/NetPlayerManager.cpp:51-57, 296-429` |
| Player connection state | `code/amax/library/Network/Player/NetPlayerConnection.cpp:35-60` |
| Join helper | `code/amax/library/Network/Core/NetJoinHelper.cpp:222-269, 302-342` |
| LAN create/join/advertise | `code/amax/library/Network/Core/NetRace.cpp:260-292, 329-364, 965-1013, 2265-2294, 2573-2599` |
| LAN Lua join | `code/amax/game/GameLogic/Lua/lua_NetRace.cpp:373-394` |
| Defines (sizes/timers) | `code/amax/library/Network/Misc/NetDefines.h:40, 70-87, 95-109` |
| Security structs | `code/mercury/library/network/include/network/Securekey.h:34-47`; `code/vendor/demonware/2.0/bdCore/bdSocket/bdSecurityID.h:17`; `.../bdSecurityKey.h:16` |
| bdNet startup | `code/vendor/demonware/2.0/bdNet/bdNet.cpp:27-156`; `bdNet.h:38-111` |
| Socket router API | `code/vendor/demonware/2.0/bdSocket/bdSocketRouter.h:9-184, 250-276` |
| Socket router implementation | `code/vendor/demonware/2.0/bdSocket/bdSocketRouter.cpp:100-158, 212-311, 354-510` |
| Address map / handle / endpoint | `code/vendor/demonware/2.0/bdSocket/bdAddressMap.h:31-45`; `bdAddrHandle.h:22-123`; `bdEndpoint.h:21-50` |
| Common address | `code/vendor/demonware/2.0/bdCore/bdSocket/bdCommonAddr.h:34-42, 78-90, 125-148` |
| Socket wrapper | `code/vendor/demonware/2.0/bdCore/bdSocket/bdSocket.h:31-87` |
| WinSock mapping | `code/vendor/demonware/2.0/bdPlatform/bdPlatformSocket/bdPlatformSocket-win32.cpp:49-287`; `bdPlatformSocket.h:23-65` |
| Datagram limits | `code/vendor/demonware/2.0/bdCore/bdSocket/bdSocketConfig.h:28-32` |

### 8.2 External specifications and documentation

- RFC 8841, *SDP Offer/Answer Procedures for SCTP over DTLS Transport*, §6
  (`max-message-size`; default 64 KiB; zero = any), §9.3 (SCTP association),
  §12.2 (ICE candidate changes and SCTP/DTLS).
  <https://www.rfc-editor.org/rfc/rfc8841.html>
- RFC 8831, *WebRTC Data Channels*; RFC 8832, *WebRTC Data Channel
  Establishment Protocol*.
- RFC 8445, *Interactive Connectivity Establishment (ICE)*;
  RFC 8656, *Traversal Using Relays around NAT (TURN)*.
- MDN, `RTCDataChannel` (`ordered`, `bufferedAmount`,
  `bufferedAmountLowThreshold`, events, transferable object).
  <https://developer.mozilla.org/en-US/docs/Web/API/RTCDataChannel>
- MDN, `RTCDataChannel.send()` (exceptions: `InvalidStateError`,
  `OperationError`, `TypeError`).
  <https://developer.mozilla.org/en-US/docs/Web/API/RTCDataChannel/send>
- MDN, *Using WebRTC data channels* (buffering, message-size limits, 64 KiB
  default, 256 KB common, head-of-line blocking, DTLS).
  <https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Using_data_channels>
- MDN, `RTCPeerConnection` (`connectionState`, `iceConnectionState`,
  `restartIce`, `getStats`, events).
  <https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection>
- Emscripten, *Networking* (no direct TCP/UDP sockets in the browser).
  <https://emscripten.org/docs/porting/networking.html>
