// T-006b — explicit little-endian encoder for the wchar_t-affected wire
// records.
//
// The native MSVC x64 layout is the wire authority (see
// docs/work/analysis/net-layout.md §3 and §8). These writers reproduce it
// field-by-field, so the wire bytes no longer depend on the compiler's
// `wchar_t` width, on the base-class tail-padding rule, or on implicit
// padding content. Every multi-byte field is written little-endian by hand.
//
// The source objects are the probe's transcription of the engine types
// (src/wire_decls.h). Using them as input is deliberate: the same field values
// are encoded natively (wchar_t = 2, MSVC layout) and on wasm32 (wchar_t = 4
// or 2, Itanium layout) and the outputs must be byte-identical.
//
// Failure is explicit: a Writer records the first overflow or an out-of-range
// value (a name unit above 0xFFFF) and the caller must test ok(). Nothing is
// truncated silently.

#ifndef WIRE_ENCODER_H
#define WIRE_ENCODER_H

#include "wire_decls.h"

#include <cstddef>
#include <cstdint>
#include <string>

namespace wirecodec
{
	// -----------------------------------------------------------------------
	// Native (MSVC x64) record sizes — the fixture authority.
	//
	// These are constants, not sizeof(): the wasm build compiles these same
	// writers against structs that are 48/80/96/128/1944/2584 bytes.
	// -----------------------------------------------------------------------
	const int kNameUnits = 17;				// SYSTEM_PROFILE_NAME_LENGTH
	const int kCommonAddressSize = 25;		// BD_COMMON_ADDR_SERIALIZED_SIZE
	const int kStartRaceSlots = 20;			// NET_MAX_VEHICLES

	const int kBaseProfileSize = 56;
	const int kPlayerVehicleSize = 24;
	const int kLoadOutSize = 12;
	const int kSharedProfileSize = 10;
	const int kProfileGameDataSize = 12;
	const int kRaceSettingsSize = 32;
	const int kNetRaceSettingsSize = 84;
	const int kStartRacePlayerSize = 104;
	const int kStartRaceHeaderSize = 24;	// top-level fields + 4 pad bytes
	const int kStartRaceSize = kStartRaceHeaderSize + kStartRaceSlots * kStartRacePlayerSize; // 2104

	const int kJoinRequest1LocalSize = 125;
	const int kJoinReplyHost1LocalSize = 117;
	const int kJoinDataHost0PeersSize = 85;

	const int kMaxRecordSize = kStartRaceSize;	// 2104

	// -----------------------------------------------------------------------
	// Bounds-checked little-endian writer.
	// -----------------------------------------------------------------------
	class Writer
	{
	public:
		Writer(unsigned char* out, int capacity);

		void u8(uint8_t v);
		void u16(uint16_t v);
		void u32(uint32_t v);
		void u64(uint64_t v);
		void f32(float v);
		void bytes(const unsigned char* p, int n);
		void zero(int n);

		// Record a failure without writing. The first failure wins.
		void fail(void);

		bool ok(void) const { return m_ok; }
		int size(void) const { return m_pos; }

	private:
		unsigned char* m_out;
		int m_capacity;
		int m_pos;
		bool m_ok;

		void put(const unsigned char* p, int n);
	};

	// -----------------------------------------------------------------------
	// Field-wise writers. Each one emits exactly the native record size
	// documented above; the caller must check Writer::ok().
	// -----------------------------------------------------------------------
	void writeBaseProfile(Writer& w, const SysProfile::BaseProfile& o);
	void writeNetPlayerVehicle(Writer& w, const RacerNet::NetPlayerVehicle& o);
	void writeNetPlayerLoadOut(Writer& w, const RacerNet::NetPlayerLoadOut& o);
	void writeNetPlayerSharedProfile(Writer& w, const RacerNet::NetPlayerSharedProfile& o);
	void writeNetPlayerProfileGameData(Writer& w, const RacerNet::NetPlayerProfileGameData& o);
	void writeRaceSettings(Writer& w, const RacerNet::RaceSettings& o);
	void writeNetRaceSettings(Writer& w, const RacerNet::NetRaceSettings& o);
	void writeStartRacePlayer(Writer& w, const RacerNet::NetStartRacePacketPlayer& o);

	// All kStartRaceSlots slots are always written. Slots >= filledSlots are
	// encoded as zero, which is the fixture policy for "the full array is
	// transmitted, only the used slots are meaningful" (net-layout.md §7).
	// filledSlots outside [0, kStartRaceSlots] is a failure.
	void writeStartRace(Writer& w, const RacerNet::NetStartRacePacket& o, int filledSlots);

	// -----------------------------------------------------------------------
	// Join records that embed BaseProfile. Only one local player is modelled,
	// because NET_MAX_LOCAL_PLAYERS = 1 (NetDefines.h:55).
	// -----------------------------------------------------------------------
	struct JoinRequestFields
	{
		uint32_t packetVersion;			// NET_PACKET_VERSION; fixture pins 0x0F000001
		uint8_t recipientJoinId;
		uint64_t hostConsoleId;
		uint64_t senderConsoleId;
		unsigned char commonAddress[kCommonAddressSize];
		uint16_t upStreamKbps;
		uint16_t downStreamKbps;
		uint32_t dlcMask;
		const SysProfile::BaseProfile* player;
		uint8_t voiceBanned;
		const RacerNet::NetPlayerProfileGameData* profileData;
		uint8_t joinId;
	};

	struct JoinReplyFields
	{
		uint8_t updatedLocalDataFollows;
		uint8_t updatedLocalCount;
		uint8_t updatedJoinId;
		uint64_t hostConsoleId;
		unsigned char commonAddress[kCommonAddressSize];
		uint16_t upStreamKbps;
		uint16_t downStreamKbps;
		uint32_t dlcMask;
		const SysProfile::BaseProfile* player;
		uint8_t joinId;
		uint8_t voiceBanned;
		const RacerNet::NetPlayerProfileGameData* profileData;
		uint8_t host;
		uint8_t playerState;
	};

	void writeJoinRequest1Local(Writer& w, const JoinRequestFields& f);
	void writeJoinReplyHost1Local(Writer& w, const JoinReplyFields& f);
	void writeJoinDataHost0Peers(Writer& w, const RacerNet::NetRaceSettings& settings);

	// -----------------------------------------------------------------------
	// SHA-256, used for the fixture banner. Implemented here so the native and
	// wasm binaries emit the same hash without an external dependency. The
	// Python runner recomputes it independently from the hex bytes.
	// -----------------------------------------------------------------------
	std::string sha256Hex(const unsigned char* data, std::size_t size);
} // namespace wirecodec

#endif // WIRE_ENCODER_H
