// T-006b — explicit little-endian encoder implementation.
// See src/wire_encoder.h for the contract and docs/work/analysis/net-layout.md
// §8.2 for why this exists.

#include "wire_encoder.h"

#include <cstring>

namespace wirecodec
{
	// -----------------------------------------------------------------------
	// Writer
	// -----------------------------------------------------------------------
	Writer::Writer(unsigned char* out, int capacity)
		: m_out(out), m_capacity(capacity), m_pos(0), m_ok(true)
	{
	}

	void Writer::fail(void)
	{
		m_ok = false;
	}

	void Writer::put(const unsigned char* p, int n)
	{
		if (n < 0 || n > m_capacity - m_pos)
		{
			m_ok = false;
			return;
		}
		if (n > 0)
		{
			std::memcpy(m_out + m_pos, p, (std::size_t)n);
			m_pos += n;
		}
	}

	void Writer::u8(uint8_t v)
	{
		const unsigned char b[1] = { (unsigned char)v };
		put(b, 1);
	}

	void Writer::u16(uint16_t v)
	{
		const unsigned char b[2] = {
			(unsigned char)(v & 0xFFu),
			(unsigned char)((v >> 8) & 0xFFu),
		};
		put(b, 2);
	}

	void Writer::u32(uint32_t v)
	{
		const unsigned char b[4] = {
			(unsigned char)(v & 0xFFu),
			(unsigned char)((v >> 8) & 0xFFu),
			(unsigned char)((v >> 16) & 0xFFu),
			(unsigned char)((v >> 24) & 0xFFu),
		};
		put(b, 4);
	}

	void Writer::u64(uint64_t v)
	{
		const unsigned char b[8] = {
			(unsigned char)(v & 0xFFu),
			(unsigned char)((v >> 8) & 0xFFu),
			(unsigned char)((v >> 16) & 0xFFu),
			(unsigned char)((v >> 24) & 0xFFu),
			(unsigned char)((v >> 32) & 0xFFu),
			(unsigned char)((v >> 40) & 0xFFu),
			(unsigned char)((v >> 48) & 0xFFu),
			(unsigned char)((v >> 56) & 0xFFu),
		};
		put(b, 8);
	}

	void Writer::f32(float v)
	{
		uint32_t bits = 0;
		std::memcpy(&bits, &v, sizeof(bits));
		u32(bits);
	}

	void Writer::bytes(const unsigned char* p, int n)
	{
		put(p, n);
	}

	void Writer::zero(int n)
	{
		if (n < 0 || n > m_capacity - m_pos)
		{
			m_ok = false;
			return;
		}
		if (n > 0)
		{
			std::memset(m_out + m_pos, 0, (std::size_t)n);
			m_pos += n;
		}
	}

	// -----------------------------------------------------------------------
	// Embedded records
	// -----------------------------------------------------------------------
	void writeBaseProfile(Writer& w, const SysProfile::BaseProfile& o)
	{
		// 0-7 uid, 8 isGuest, 9-15 padding, 16-49 name, 50-55 tail padding.
		w.u64((uint64_t)o.m_Uid);
		w.u8(o.m_IsGuest ? 1u : 0u);
		w.zero(7);
		for (int i = 0; i < kNameUnits; ++i)
		{
			const uint32_t unit = (uint32_t)o.m_Name[i];
			if (unit > 0xFFFFu)
			{
				// The wire name is UTF-16LE by contract; a wider code unit has
				// no defined encoding here. Refuse rather than truncate.
				w.fail();
				return;
			}
			w.u16((uint16_t)unit);
		}
		w.zero(6);
	}

	void writeNetPlayerVehicle(Writer& w, const RacerNet::NetPlayerVehicle& o)
	{
		w.u32((uint32_t)o.m_xtVehicleId);			// 0
		w.u32((uint32_t)o.m_xtColourId);			// 4
		// 8: contentPack bits 0-14, autoGears bit 15 in the U16 allocation unit.
		const uint16_t word8 = (uint16_t)(
			((uint32_t)o.m_VehicleContentPack & 0x7FFFu) |
			(((uint32_t)o.m_AutoGears & 0x1u) << 15));
		w.u16(word8);
		// The U16 bitfield unit ends at 9; bytes 10-11 are padding.
		w.zero(2);
		w.u32((uint32_t)o.m_CharacterId);			// 12
		// 16: pickupSlots 16 bits, shieldSlots 8, additionalHealthPips 8.
		const uint32_t word16 =
			((uint32_t)o.m_PickupSlots & 0xFFFFu) |
			(((uint32_t)o.m_ShieldSlots & 0xFFu) << 16) |
			(((uint32_t)o.m_AdditionalHealthPips & 0xFFu) << 24);
		w.u32(word16);
		// 20: additionalHP uses one bit; the remaining 31 bits are never
		// written by the engine, so the fixture pins them to zero.
		w.u32((uint32_t)o.m_AdditionalHP & 0x1u);
	}

	void writeNetPlayerLoadOut(Writer& w, const RacerNet::NetPlayerLoadOut& o)
	{
		// slots is `E_MULTIPLAYER_LOADOUT_SLOT_MAX` (3) 4-byte enums.
		for (int i = 0; i < UI::E_MULTIPLAYER_LOADOUT_SLOT_MAX; ++i)
		{
			w.u32((uint32_t)(int32_t)o.slots.storage[i]);
		}
	}

	void writeNetPlayerSharedProfile(Writer& w, const RacerNet::NetPlayerSharedProfile& o)
	{
		w.u16((uint16_t)o.m_RacePointsThisSession);	// 0
		w.u8((uint8_t)o.m_Rank);					// 2
		w.u8((uint8_t)o.m_Legend);					// 3
		w.u8((uint8_t)o.m_WinningStreak);			// 4
		w.u8((uint8_t)o.m_RacesThisSession);		// 5
		w.u8((uint8_t)o.m_WinsThisSession);			// 6
		w.u8(o.m_BlurDeveloper ? 1u : 0u);			// 7
		w.u8(o.m_HasBeatenBizarre ? 1u : 0u);		// 8
		w.zero(1);									// 9 tail padding
	}

	void writeNetPlayerProfileGameData(Writer& w, const RacerNet::NetPlayerProfileGameData& o)
	{
		writeNetPlayerSharedProfile(w, o.m_Game);
		w.u8((uint8_t)o.m_UserCreatedContentAvailable);	// 10
		w.u8((uint8_t)o.m_NatType);						// 11
	}

	void writeRaceSettings(Writer& w, const RacerNet::RaceSettings& o)
	{
		w.u32((uint32_t)o.m_xtCityId);			// 0
		w.u32((uint32_t)o.m_xtRouteId);			// 4
		w.u8((uint8_t)o.m_MinPlayers);			// 8
		w.u8((uint8_t)o.m_MaxPlayers);			// 9
		w.u8((uint8_t)o.m_Type);				// 10
		w.u8((uint8_t)o.m_NumLaps);				// 11
		w.u32((uint32_t)o.m_TimeLimit);			// 12
		w.u8((uint8_t)o.m_Class);				// 16
		w.u8((uint8_t)o.m_DamageMode);			// 17
		w.u8((uint8_t)o.m_Respawn);				// 18
		w.u8((uint8_t)o.m_Timeout);				// 19
		w.u8((uint8_t)o.m_Mods);				// 20
		w.u8((uint8_t)o.m_Upgrades);			// 21
		w.u8((uint8_t)o.m_LockToHostCar);		// 22
		w.u8((uint8_t)o.m_AI);					// 23
		w.u8((uint8_t)o.m_AIMaxPadding);		// 24
		w.u8((uint8_t)o.m_Handicap);			// 25
		w.u16((uint16_t)o.m_Pickups);			// 26
		w.u8((uint8_t)o.m_RandomPickups);		// 28
		w.u8((uint8_t)o.m_PickupsRespawnMode);	// 29
		w.zero(2);								// 30-31 tail padding
	}

	void writeNetRaceSettings(Writer& w, const RacerNet::NetRaceSettings& o)
	{
		w.u16((uint16_t)o.m_PackVersion);		// 0
		w.zero(2);								// 2-3 padding (m_Name is U32)
		w.u32((uint32_t)o.m_Name);				// 4
		w.u32((uint32_t)o.m_Description);		// 8
		w.u32((uint32_t)o.m_EventId);			// 12

		// 16: one U8 allocation unit holding five 1-bit fields; bits 5-7 are
		// unused by the declarations and pinned to zero by the fixture.
		const uint8_t b16 = (uint8_t)(
			((uint32_t)o.m_CustomRace & 0x1u) |
			(((uint32_t)o.m_PublicGame & 0x1u) << 1) |
			(((uint32_t)o.m_Ranked & 0x1u) << 2) |
			(((uint32_t)o.m_Championship & 0x1u) << 3) |
			(((uint32_t)o.m_Teams & 0x1u) << 4));
		w.u8(b16);
		w.u8((uint8_t)((uint32_t)o.m_MinDrivers & 0x1Fu));	// 17
		w.u8((uint8_t)((uint32_t)o.m_MaxDrivers & 0x1Fu));	// 18
		w.zero(1);											// 19 padding

		w.f32((float)o.m_FanMultiplier);					// 20

		w.u8((uint8_t)((uint32_t)o.m_HasAnyRacesStarted & 0x1u));	// 24
		w.zero(1);													// 25 padding
		w.u16((uint16_t)o.m_Misc);									// 26
		w.u8((uint8_t)o.m_LobbyState);								// 28
		w.zero(3);													// 29-31 padding
		w.f32((float)o.m_LobbyTimer);								// 32
		w.u8((uint8_t)o.m_VoteCountA);								// 36
		w.u8((uint8_t)o.m_VoteCountB);								// 37
		w.u16((uint16_t)o.m_VoteIndexA);							// 38
		w.u16((uint16_t)o.m_VoteIndexB);							// 40
		w.zero(2);													// 42-43 padding
		w.u32((uint32_t)o.m_PlaylistSeed);							// 44
		w.u16((uint16_t)o.m_PlaylistIndex);							// 48
		w.zero(2);													// 50-51 padding
		writeRaceSettings(w, o.m_Race);								// 52-83
	}

	void writeStartRacePlayer(Writer& w, const RacerNet::NetStartRacePacketPlayer& o)
	{
		writeBaseProfile(w, o.m_User);				// 0-55
		w.u8((uint8_t)o.mJoinRef);					// 56
		w.u8((uint8_t)o.mPrimaryJoinRef);			// 57
		w.u8((uint8_t)o.mStartPos);					// 58
		w.u8((uint8_t)o.mTeam);						// 59
		w.u8((uint8_t)o.mAiAvatarId);				// 60
		w.u8((uint8_t)o.mAiMultiplayerRank);		// 61
		w.zero(2);									// 62-63 padding
		writeNetPlayerVehicle(w, o.mVehicle);		// 64-87
		writeNetPlayerLoadOut(w, o.mLoadOut);		// 88-99
		w.zero(4);									// 100-103 tail padding
	}

	void writeStartRace(Writer& w, const RacerNet::NetStartRacePacket& o, int filledSlots)
	{
		if (filledSlots < 0 || filledSlots > kStartRaceSlots)
		{
			w.fail();
			return;
		}

		w.u64((uint64_t)o.mHostId);				// 0
		w.u32((uint32_t)o.mHostStartTime);		// 8
		w.u32((uint32_t)o.mRandomSeed);			// 12
		w.u8((uint8_t)o.mNumPlayerVehicles);	// 16
		w.u8((uint8_t)o.mNumAIVehicles);		// 17
		w.u8((uint8_t)o.mOriginalHostJoinId);	// 18
		w.u8((uint8_t)o.mEvntIndex);			// 19
		w.zero(4);								// 20-23 padding

		for (int i = 0; i < kStartRaceSlots; ++i)
		{
			if (i < filledSlots)
			{
				writeStartRacePlayer(w, o.mPlayer.storage[i]);
			}
			else
			{
				// Unfilled slots travel as zeros in the fixture. The engine
				// sends all 20 slots but rewrites only the used ones; the
				// stale-name defect is documented in net-layout.md §7 and is
				// not reproduced here.
				w.zero(kStartRacePlayerSize);
			}
			if (!w.ok())
			{
				return;
			}
		}
	}

	// -----------------------------------------------------------------------
	// Join records
	// -----------------------------------------------------------------------
	void writeJoinRequest1Local(Writer& w, const JoinRequestFields& f)
	{
		if (f.player == nullptr || f.profileData == nullptr)
		{
			w.fail();
			return;
		}
		w.u32(f.packetVersion);							// 0
		w.u8(f.recipientJoinId);						// 4
		w.u64(f.hostConsoleId);							// 5
		w.u64(f.senderConsoleId);						// 13
		w.bytes(f.commonAddress, kCommonAddressSize);	// 21
		w.u16(f.upStreamKbps);							// 46
		w.u16(f.downStreamKbps);						// 48
		w.u32(f.dlcMask);								// 50
		w.u8(1);										// 54 localPlayerCount
		writeBaseProfile(w, *f.player);					// 55
		w.u8(f.voiceBanned);							// 111
		writeNetPlayerProfileGameData(w, *f.profileData);	// 112
		w.u8(f.joinId);									// 124
	}

	void writeJoinReplyHost1Local(Writer& w, const JoinReplyFields& f)
	{
		if (f.player == nullptr || f.profileData == nullptr)
		{
			w.fail();
			return;
		}
		w.u8(f.updatedLocalDataFollows);				// 0
		w.u8(f.updatedLocalCount);						// 1
		w.u8(f.updatedJoinId);							// 2
		w.u64(f.hostConsoleId);							// 3
		w.bytes(f.commonAddress, kCommonAddressSize);	// 11
		w.u16(f.upStreamKbps);							// 36
		w.u16(f.downStreamKbps);						// 38
		w.u32(f.dlcMask);								// 40
		w.u8(1);										// 44 localPlayerCount
		writeBaseProfile(w, *f.player);					// 45
		w.u8(f.joinId);									// 101
		w.u8(f.voiceBanned);							// 102
		writeNetPlayerProfileGameData(w, *f.profileData);	// 103
		w.u8(f.host);									// 115
		w.u8(f.playerState);							// 116
	}

	void writeJoinDataHost0Peers(Writer& w, const RacerNet::NetRaceSettings& settings)
	{
		writeNetRaceSettings(w, settings);	// 0-83
		w.u8(0);							// 84 additionalPeerCount
	}

	// -----------------------------------------------------------------------
	// SHA-256 (FIPS 180-4), no external dependency.
	// -----------------------------------------------------------------------
	namespace
	{
		uint32_t rotr(uint32_t x, int n)
		{
			return (x >> n) | (x << (32 - n));
		}

		void sha256Block(uint32_t state[8], const unsigned char block[64])
		{
			static const uint32_t k[64] = {
				0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u,
				0x3956c25bu, 0x59f111f1u, 0x923f82a4u, 0xab1c5ed5u,
				0xd807aa98u, 0x12835b01u, 0x243185beu, 0x550c7dc3u,
				0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u, 0xc19bf174u,
				0xe49b69c1u, 0xefbe4786u, 0x0fc19dc6u, 0x240ca1ccu,
				0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau,
				0x983e5152u, 0xa831c66du, 0xb00327c8u, 0xbf597fc7u,
				0xc6e00bf3u, 0xd5a79147u, 0x06ca6351u, 0x14292967u,
				0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu, 0x53380d13u,
				0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u,
				0xa2bfe8a1u, 0xa81a664bu, 0xc24b8b70u, 0xc76c51a3u,
				0xd192e819u, 0xd6990624u, 0xf40e3585u, 0x106aa070u,
				0x19a4c116u, 0x1e376c08u, 0x2748774cu, 0x34b0bcb5u,
				0x391c0cb3u, 0x4ed8aa4au, 0x5b9cca4fu, 0x682e6ff3u,
				0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u,
				0x90befffau, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u,
			};

			uint32_t w[64];
			for (int i = 0; i < 16; ++i)
			{
				w[i] = ((uint32_t)block[i * 4] << 24) |
					((uint32_t)block[i * 4 + 1] << 16) |
					((uint32_t)block[i * 4 + 2] << 8) |
					(uint32_t)block[i * 4 + 3];
			}
			for (int i = 16; i < 64; ++i)
			{
				const uint32_t s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
				const uint32_t s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
				w[i] = w[i - 16] + s0 + w[i - 7] + s1;
			}

			uint32_t a = state[0], b = state[1], c = state[2], d = state[3];
			uint32_t e = state[4], f = state[5], g = state[6], h = state[7];

			for (int i = 0; i < 64; ++i)
			{
				const uint32_t s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
				const uint32_t ch = (e & f) ^ ((~e) & g);
				const uint32_t t1 = h + s1 + ch + k[i] + w[i];
				const uint32_t s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
				const uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
				const uint32_t t2 = s0 + maj;
				h = g;
				g = f;
				f = e;
				e = d + t1;
				d = c;
				c = b;
				b = a;
				a = t1 + t2;
			}

			state[0] += a; state[1] += b; state[2] += c; state[3] += d;
			state[4] += e; state[5] += f; state[6] += g; state[7] += h;
		}
	}

	std::string sha256Hex(const unsigned char* data, std::size_t size)
	{
		uint32_t state[8] = {
			0x6a09e667u, 0xbb67ae85u, 0x3c6ef372u, 0xa54ff53au,
			0x510e527fu, 0x9b05688cu, 0x1f83d9abu, 0x5be0cd19u,
		};

		std::size_t offset = 0;
		while (size - offset >= 64)
		{
			sha256Block(state, data + offset);
			offset += 64;
		}

		unsigned char tail[128];
		std::memset(tail, 0, sizeof(tail));
		const std::size_t remaining = size - offset;
		if (remaining > 0)
		{
			std::memcpy(tail, data + offset, remaining);
		}
		tail[remaining] = 0x80;
		const std::size_t tailBlocks = (remaining + 1 + 8 <= 64) ? 1 : 2;
		const std::size_t bitsOffset = tailBlocks * 64 - 8;
		const uint64_t bitLength = (uint64_t)size * 8u;
		for (int i = 0; i < 8; ++i)
		{
			tail[bitsOffset + (std::size_t)i] = (unsigned char)((bitLength >> (56 - 8 * i)) & 0xFFu);
		}
		for (std::size_t i = 0; i < tailBlocks; ++i)
		{
			sha256Block(state, tail + i * 64);
		}

		static const char* digits = "0123456789abcdef";
		std::string out;
		out.reserve(64);
		for (int i = 0; i < 8; ++i)
		{
			for (int shift = 28; shift >= 0; shift -= 4)
			{
				out += digits[(state[i] >> shift) & 0xFu];
			}
		}
		return out;
	}
} // namespace wirecodec
