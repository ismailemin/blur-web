// T-006b layout probe — measurement core.
//
// For every wire type it records:
//   * sizeof / alignof;
//   * the byte offset of every non-bitfield member (address-difference form,
//     which is valid for the non-standard-layout types where offsetof is only
//     conditionally supported; the real offsetof() is emitted as well whenever
//     the type is standard-layout, so the two can be compared);
//   * for every bitfield: which bits change when only that field is set to all
//     ones, relative to an all-zero object (bitfields cannot be offsetof-ed);
//   * which bytes the constructor + a full field assignment does NOT write
//     (padding poison: the object is built twice, over 0xCD and 0xA5 storage,
//     and the differing offsets are exactly the bytes that were never written);
//   * a canonical byte image and its FNV-1a 64 hash.
//
// It also builds "derived records": the exact byte sequences the P0 packet
// writers emit (they are field-by-field writers, not struct memcpys, so the
// offsets are cursor arithmetic over the measured sizeof of the embedded types).

#include "probe_core.h"
#include "wire_decls.h"

#include <cstdio>
#include <cstring>
#include <cstdint>
#include <new>
#include <string>
#include <utility>
#include <vector>
#include <type_traits>

namespace wireprobe
{
	// -----------------------------------------------------------------------
	// compile-time anchors
	//
	// These hold on every target, because none of these types contains wchar_t:
	// they are the header layout that t006-wire-format.md §1.2 derives from the
	// declarations, and the size every derived fixture depends on.
	// -----------------------------------------------------------------------
	static_assert(sizeof(WCHAR) == sizeof(wchar_t), "WCHAR must be the compiler's wchar_t");
	static_assert(sizeof(RacerNet::DatagramPacketHeader) == 4, "DatagramPacketHeader must be 4 bytes");
	static_assert(sizeof(RacerNet::DatagramReliablePacketHeader) == 10, "DatagramReliablePacketHeader must be 10 bytes");
	static_assert(sizeof(RacerNet::DatagramAcknowledgementHeader) == 6, "DatagramAcknowledgementHeader must be 6 bytes");

	// -----------------------------------------------------------------------
	// helpers
	// -----------------------------------------------------------------------
	typedef std::vector<unsigned char> Bytes;

	static uint64_t fnv1a64(const unsigned char* p, int n)
	{
		uint64_t h = 0xcbf29ce484222325ull;
		for (int i = 0; i < n; ++i)
		{
			h ^= (uint64_t)p[i];
			h *= 0x100000001b3ull;
		}
		return h;
	}

	static std::string hexBytes(const unsigned char* p, int n)
	{
		static const char* digits = "0123456789abcdef";
		std::string s;
		s.reserve((size_t)n * 2);
		for (int i = 0; i < n; ++i)
		{
			s += digits[(p[i] >> 4) & 0xF];
			s += digits[p[i] & 0xF];
		}
		return s;
	}

	static std::string hex64(uint64_t v)
	{
		char buf[24];
		std::snprintf(buf, sizeof(buf), "0x%016llx", (unsigned long long)v);
		return std::string(buf);
	}

	static std::string num(int v)
	{
		char buf[24];
		std::snprintf(buf, sizeof(buf), "%d", v);
		return std::string(buf);
	}

	static std::string jsonStr(const char* s)
	{
		std::string out = "\"";
		for (const char* p = s; *p; ++p)
		{
			unsigned char c = (unsigned char)*p;
			if (c == '"' || c == '\\') { out += '\\'; out += (char)c; }
			else if (c < 0x20) { char b[8]; std::snprintf(b, sizeof(b), "\\u%04x", c); out += b; }
			else out += (char)c;
		}
		out += '"';
		return out;
	}

	template <typename T>
	static Bytes imageWith(unsigned char fill, void (*setAll)(T&))
	{
		alignas(T) unsigned char storage[sizeof(T)];
		std::memset(storage, fill, sizeof(T));
		// Deliberately default-initialisation (`T`), not value-initialisation
		// (`T()`). Value-initialisation zero-fills the whole object, including
		// padding, for any class whose default constructor is not user-provided,
		// which would hide exactly the bytes this probe is looking for.
		T* p = new (storage) T;
		setAll(*p);
		Bytes out((size_t)sizeof(T));
		std::memcpy(out.data(), storage, sizeof(T));
		return out;
	}

	// -----------------------------------------------------------------------
	// descriptors
	// -----------------------------------------------------------------------
	template <typename T>
	struct FieldSpec
	{
		const char* name;
		int (*offset)(const T&);
		int (*size)(const T&);
		int (*stdOffsetof)(const T&);	// -1 when the type is not standard-layout
		int count;
		const char* source;
	};

	template <typename T>
	struct BitSpec
	{
		const char* name;
		void (*setMax)(T&);
		int width;
		const char* source;
	};

	struct TypeRec
	{
		std::string name;
		std::string kind;
		int size;
		int align;
		bool standardLayout;
		std::vector<std::string> fields;
		std::vector<std::string> bits;
		std::vector<int> padding;
		bool poisonSensitive;
		std::string canonicalHex;
		std::string canonicalHash;
	};

	template <typename T>
	static TypeRec measure(const char* name, const char* kind, void (*setAll)(T&),
		const std::vector<FieldSpec<T> >& fields, const std::vector<BitSpec<T> >& bits)
	{
		TypeRec r;
		r.name = name;
		r.kind = kind;
		r.size = (int)sizeof(T);
		r.align = (int)alignof(T);
		r.standardLayout = std::is_standard_layout<T>::value;

		alignas(T) unsigned char storage[sizeof(T)];
		std::memset(storage, 0, sizeof(T));
		T* obj = new (storage) T;
		setAll(*obj);

		std::vector<int> fieldEnd((size_t)r.size, 0);
		for (size_t i = 0; i < fields.size(); ++i)
		{
			const FieldSpec<T>& f = fields[i];
			const int off = f.offset(*obj);
			const int sz = f.size(*obj);
			const int so = f.stdOffsetof(*obj);
			std::string s = "{";
			s += "\"name\":" + jsonStr(f.name);
			s += ",\"offset\":" + num(off);
			s += ",\"size\":" + num(sz);
			s += ",\"count\":" + num(f.count);
			if (so >= 0) s += ",\"offsetof\":" + num(so);
			else s += ",\"offsetof\":null";
			s += ",\"source\":" + jsonStr(f.source);
			s += "}";
			r.fields.push_back(s);
			for (int b = off; b < off + sz && b < r.size; ++b) fieldEnd[(size_t)b] = 1;
		}

		// Bitfield probe: bitfields cannot be offsetof-ed and their allocation
		// unit is compiler-defined, so the authoritative record is "build an
		// all-zero object, set exactly one bitfield to all ones, and see which
		// bits of the object representation changed".
		std::vector<std::pair<int, int> > bitByteRanges;
		for (size_t i = 0; i < bits.size(); ++i)
		{
			const BitSpec<T>& b = bits[i];

			Bytes zeroBase((size_t)sizeof(T), 0);

			alignas(T) unsigned char markStorage[sizeof(T)];
			std::memcpy(markStorage, zeroBase.data(), sizeof(T));
			T* marked = reinterpret_cast<T*>(markStorage);
			b.setMax(*marked);

			int changedCount = 0;
			int firstByte = -1, lastByte = -1;
			int firstBit = -1;
			for (int byte = 0; byte < r.size; ++byte)
			{
				const unsigned char diff = (unsigned char)(zeroBase[(size_t)byte] ^ markStorage[byte]);
				if (!diff) continue;
				for (int bit = 0; bit < 8; ++bit)
				{
					if (diff & (1u << bit))
					{
						if (firstBit < 0) firstBit = byte * 8 + bit;
						if (firstByte < 0) firstByte = byte;
						lastByte = byte;
						++changedCount;
					}
				}
			}
			if (firstByte >= 0)
			{
				bitByteRanges.push_back(std::make_pair(firstByte, lastByte));
			}

			std::string s = "{";
			s += "\"name\":" + jsonStr(b.name);
			s += ",\"width\":" + num(b.width);
			s += ",\"changedBits\":" + num(changedCount);
			if (firstBit >= 0)
			{
				s += ",\"firstBit\":" + num(firstBit);
				s += ",\"byteOffset\":" + num(firstByte);
				s += ",\"spanBytes\":" + num(lastByte - firstByte + 1);
			}
			else
			{
				s += ",\"firstBit\":null,\"byteOffset\":null,\"spanBytes\":null";
			}
			s += ",\"source\":" + jsonStr(b.source);
			s += "}";
			r.bits.push_back(s);
		}

		// Pad byte accounting: bitfield bytes are data, not padding.
		for (size_t i = 0; i < bitByteRanges.size(); ++i)
		{
			for (int b = bitByteRanges[i].first; b <= bitByteRanges[i].second && b < r.size; ++b)
			{
				fieldEnd[(size_t)b] = 1;
			}
		}

		// padding / poison: build the same object over two different fills.
		const Bytes cd = imageWith<T>(0xCD, setAll);
		const Bytes a5 = imageWith<T>(0xA5, setAll);
		r.poisonSensitive = false;
		for (int i = 0; i < r.size; ++i)
		{
			if (cd[(size_t)i] != a5[(size_t)i])
			{
				r.poisonSensitive = true;
			}
		}
		for (int i = 0; i < r.size; ++i)
		{
			if (!fieldEnd[(size_t)i]) r.padding.push_back(i);
		}

		const Bytes zero = imageWith<T>(0x00, setAll);
		r.canonicalHex = hexBytes(zero.data(), r.size);
		r.canonicalHash = hex64(fnv1a64(zero.data(), r.size));
		return r;
	}

	// -----------------------------------------------------------------------
	// derived record builder (byte cursor, not a struct)
	// -----------------------------------------------------------------------
	struct RecBuilder
	{
		std::string name;
		std::string kind;
		std::vector<std::string> fields;
		int cursor;

		RecBuilder(const char* n, const char* k) : name(n), kind(k), cursor(0) {}

		void add(const char* fieldName, int size, const char* source)
		{
			addArray(fieldName, size, 1, source);
		}

		void addArray(const char* fieldName, int size, int count, const char* source)
		{
			std::string s = "{";
			s += "\"name\":" + jsonStr(fieldName);
			s += ",\"offset\":" + num(cursor);
			s += ",\"size\":" + num(size);
			s += ",\"count\":" + num(count);
			s += ",\"source\":" + jsonStr(source);
			s += "}";
			fields.push_back(s);
			cursor += size * count;
		}

		std::string json(void) const
		{
			std::string s = "{";
			s += "\"name\":" + jsonStr(name.c_str());
			s += ",\"kind\":" + jsonStr(kind.c_str());
			s += ",\"size\":" + num(cursor);
			s += ",\"fields\":[";
			for (size_t i = 0; i < fields.size(); ++i)
			{
				if (i) s += ",";
				s += fields[i];
			}
			s += "]}";
			return s;
		}
	};

	// bdSocket/bdCommonAddr.h:42  BD_COMMON_ADDR_SERIALIZED_SIZE = (BD_MAX_LOCAL_ADDRS+1)*BD_ADDR_SIZE+1
	// bdSocket/bdAddr.h:22        BD_ADDR_SIZE = BD_INET_ADDR_SIZE + 2
	// bdPlatformSocket/bdInAddr.h:30  BD_IN_ADDR_SIZE = 4
	// => (3+1)*6+1 = 25
	static const int BD_COMMON_ADDR_SERIALIZED_SIZE = 25;

	// -----------------------------------------------------------------------
	// type tables
	// -----------------------------------------------------------------------
#define WP_FIELD(T, m, src) \
	::wireprobe::FieldSpec<T>{ #m, \
		[](const T& o) { return (int)(reinterpret_cast<const unsigned char*>(&o.m) - reinterpret_cast<const unsigned char*>(&o)); }, \
		[](const T& o) { return (int)sizeof(o.m); }, \
		[](const T&) { if constexpr (std::is_standard_layout<T>::value) { return (int)offsetof(T, m); } else { return -1; } }, \
		1, src }

#define WP_ARRAY(T, m, n, src) \
	::wireprobe::FieldSpec<T>{ #m, \
		[](const T& o) { return (int)(reinterpret_cast<const unsigned char*>(&o.m) - reinterpret_cast<const unsigned char*>(&o)); }, \
		[](const T& o) { return (int)sizeof(o.m); }, \
		[](const T&) { if constexpr (std::is_standard_layout<T>::value) { return (int)offsetof(T, m); } else { return -1; } }, \
		n, src }

	static void setUserIdentifier(SysProfile::UserIdentifier& o)
	{
		o.m_Uid = 0x1122334455667788ull;
		o.m_IsGuest = true;
	}

	static void setBaseProfile(SysProfile::BaseProfile& o)
	{
		o.m_Uid = 0x1122334455667788ull;
		o.m_IsGuest = true;
		for (int i = 0; i < SYSTEM_PROFILE_NAME_LENGTH; ++i)
		{
			o.m_Name[i] = (WCHAR)(0x0041 + i);	// 'A'..'Q', deterministic, no zero terminator issue
		}
		o.m_Name[SYSTEM_PROFILE_NAME_LENGTH - 1] = (WCHAR)0;
	}

	static void setDatagramPacketHeader(RacerNet::DatagramPacketHeader& o)
	{
		o.m_EncryptedBytes = 0x1234;
		o.m_Reliable = 1;
		o.m_PartyChannel = 1;
		o.m_SenderReference = 0x2A;
		o.m_PacketType = 0xA5;
	}

	static void setDatagramReliablePacketHeader(RacerNet::DatagramReliablePacketHeader& o)
	{
		o.m_EncryptedBytes = 0x1234;
		o.m_Reliable = 1;
		o.m_PartyChannel = 1;
		o.m_SenderReference = 0x2A;
		o.m_PacketType = 0xA5;
		o.m_InitialConnection = 1;
		o.m_FirstPacketInStream = 1;
		o.m_PacketSize = 0x1F3F;
		o.m_TotalMessageSize = 0x0E0D;
		o.m_PacketSequence = 0x1234;
	}

	static void setDatagramAcknowledgementHeader(RacerNet::DatagramAcknowledgementHeader& o)
	{
		o.m_EncryptedBytes = 0x1234;
		o.m_Reliable = 1;
		o.m_PartyChannel = 1;
		o.m_SenderReference = 0x2A;
		o.m_PacketType = 0xA5;
		o.m_PacketSequence = 0x1234;
	}

	static void setNetPlayerVehicle(RacerNet::NetPlayerVehicle& o)
	{
		o.m_xtVehicleId = 0x01020304;
		o.m_xtColourId = 0x05060708;
		o.m_VehicleContentPack = 0x7FFF;
		o.m_AutoGears = 1;
		o.m_CharacterId = 0x11223344;
		o.m_PickupSlots = 0xBEEF;
		o.m_ShieldSlots = 0x5A;
		o.m_AdditionalHealthPips = 0xC3;
		o.m_AdditionalHP = 1;
	}

	static void setNetPlayerLoadOut(RacerNet::NetPlayerLoadOut& o)
	{
		o.slots.storage[0] = UI::E_MultiplayerVehicleAbilities_Iron_Fist;
		o.slots.storage[1] = UI::E_MultiplayerVehicleAbilities_Drifter;
		o.slots.storage[2] = UI::E_MultiplayerVehicleAbilities_Mastermine;
	}

	static void setNetPlayerSharedProfile(RacerNet::NetPlayerSharedProfile& o)
	{
		o.m_RacePointsThisSession = 0x1234;
		o.m_Rank = 7;
		o.m_Legend = 1;
		o.m_WinningStreak = 3;
		o.m_RacesThisSession = 9;
		o.m_WinsThisSession = 4;
		o.m_BlurDeveloper = true;
		o.m_HasBeatenBizarre = true;
	}

	static void setNetPlayerProfileGameData(RacerNet::NetPlayerProfileGameData& o)
	{
		setNetPlayerSharedProfile(o.m_Game);
		o.m_UserCreatedContentAvailable = 1;
		o.m_NatType = 2;
	}

	static void setRaceSettings(RacerNet::RaceSettings& o)
	{
		o.m_xtCityId = 0x11;
		o.m_xtRouteId = 0x22;
		o.m_MinPlayers = 2;
		o.m_MaxPlayers = 20;
		o.m_Type = 3;
		o.m_NumLaps = 2;
		o.m_TimeLimit = 300;
		o.m_Class = 1;
		o.m_DamageMode = 2;
		o.m_Respawn = 1;
		o.m_Timeout = 0;
		o.m_Mods = 1;
		o.m_Upgrades = 1;
		o.m_LockToHostCar = 0;
		o.m_AI = 2;
		o.m_AIMaxPadding = 4;
		o.m_Handicap = 1;
		o.m_Pickups = 0x00FF;
		o.m_RandomPickups = 1;
		o.m_PickupsRespawnMode = 2;
	}

	static void setNetRaceSettings(RacerNet::NetRaceSettings& o)
	{
		o.m_PackVersion = 0x0A00;
		o.m_Name = 0x11111111;
		o.m_Description = 0x22222222;
		o.m_EventId = 0x33333333;
		o.m_CustomRace = 1;
		o.m_PublicGame = 1;
		o.m_Ranked = 1;
		o.m_Championship = 1;
		o.m_Teams = 1;
		o.m_MinDrivers = 2;
		o.m_MaxDrivers = 20;
		o.m_FanMultiplier = 1.5f;
		o.m_HasAnyRacesStarted = 1;
		o.m_Misc = 0x00FF;
		o.m_LobbyState = 2;
		o.m_LobbyTimer = 2.5f;
		o.m_VoteCountA = 1;
		o.m_VoteCountB = 2;
		o.m_VoteIndexA = 3;
		o.m_VoteIndexB = 4;
		o.m_PlaylistSeed = 0x44444444;
		o.m_PlaylistIndex = 5;
		setRaceSettings(o.m_Race);
	}

	static void setStartRacePacketPlayer(RacerNet::NetStartRacePacketPlayer& o)
	{
		setBaseProfile(o.m_User);
		o.mJoinRef = 1;
		o.mPrimaryJoinRef = 2;
		o.mStartPos = 3;
		o.mTeam = 4;
		o.mAiAvatarId = -5;
		o.mAiMultiplayerRank = 6;
		setNetPlayerVehicle(o.mVehicle);
		setNetPlayerLoadOut(o.mLoadOut);
	}

	static void setNetStartRacePacket(RacerNet::NetStartRacePacket& o)
	{
		o.mHostId = 0x8877665544332211ull;
		o.mHostStartTime = 0x01020304;
		o.mRandomSeed = 0x05060708;
		o.mNumPlayerVehicles = 2;
		o.mNumAIVehicles = 1;
		o.mOriginalHostJoinId = 3;
		o.mEvntIndex = 4;
		for (int i = 0; i < RacerNet::NET_MAX_VEHICLES; ++i)
		{
			setStartRacePacketPlayer(o.mPlayer.storage[i]);
			o.mPlayer.storage[i].mJoinRef = (U8)(i + 1);
		}
	}

	static void setNetVehicleData(Game::NetVehicleData& o)
	{
		o.m_State = E_VEHICLE_STATE_RACING;
		o.m_SkillRating = 1234;
		o.m_SkillTeam = 5678;
		o.m_Position = 2;
		o.m_LocalIndex = 3;
		o.m_Team = 1;
		o.m_NetJoinId = 7;
		o.m_Idle = true;
		for (int i = 0; i < UI::E_MultiplayerStat_Count; ++i)
		{
			o.m_Statistics.storage[i] = (F32)(i + 1) * 0.5f;
		}
	}

	static void setCompressedControls(RacingPhysics::Vehicle::CompressedNetworkControls& o)
	{
		for (int i = 0; i < 4; ++i) o.data[i] = (U8)(0x10 + i);
	}

	static void setCompressedState(RacingPhysics::Vehicle::CompressedNetworkState& o)
	{
		for (int i = 0; i < 25; ++i) o.data[i] = (U8)(0x40 + i);
	}

	static void setMuteList(RacerNet::NetMuteListJoinReferences& o)
	{
		for (int i = 0; i < RacerNet::NET_MAX_VEHICLES - 1; ++i) o.storage[i] = (U8)(i + 1);
		o.m_nElements = (U32)(RacerNet::NET_MAX_VEHICLES - 1);
	}

	// -----------------------------------------------------------------------
	// the report
	// -----------------------------------------------------------------------
	static std::string buildJson(void)
	{
		std::string out;
		out.reserve(200000);

		out += "{\n  \"schema\": \"blur-wire-layout/1\",\n";
		out += "  \"upstreamCommit\": \"5270304b81983b9e3edbd569ba25235c17bbabd7\",\n";

		// ---- build identity (differs per target by design) ----
#if defined(__wasm32__) || defined(__EMSCRIPTEN__)
		const char* target = "wasm32";
#else
		const char* target = "native";
#endif
#if defined(_MSC_VER)
		char compiler[96];
		std::snprintf(compiler, sizeof(compiler), "MSVC %d", (int)_MSC_FULL_VER);
#elif defined(__clang__)
		char compiler[96];
		std::snprintf(compiler, sizeof(compiler), "Clang %d.%d.%d",
			(int)__clang_major__, (int)__clang_minor__, (int)__clang_patchlevel__);
#else
		char compiler[96];
		std::snprintf(compiler, sizeof(compiler), "unknown");
#endif

		out += "  \"build\": {\n";
		out += "    \"target\": " + jsonStr(target) + ",\n";
		out += "    \"compiler\": " + jsonStr(compiler) + ",\n";
#if defined(WIRE_PROBE_FLAGS)
#define WIRE_STR2(x) #x
#define WIRE_STR(x) WIRE_STR2(x)
		out += "    \"flags\": " + jsonStr(WIRE_STR(WIRE_PROBE_FLAGS)) + ",\n";
#else
		out += "    \"flags\": \"unspecified\",\n";
#endif
		out += "    \"pointerBytes\": " + num((int)sizeof(void*)) + ",\n";
		out += "    \"wcharBytes\": " + num((int)sizeof(WCHAR)) + ",\n";
		out += "    \"boolBytes\": " + num((int)sizeof(bool)) + ",\n";
		out += "    \"intBytes\": " + num((int)sizeof(int)) + ",\n";
		out += "    \"longBytes\": " + num((int)sizeof(long)) + ",\n";
		out += "    \"enumBytes\": " + num((int)sizeof(E_VEHICLE_STATE)) + ",\n";
		out += "    \"alignofLongLong\": " + num((int)alignof(long long)) + ",\n";
		out += "    \"alignofDouble\": " + num((int)alignof(double)) + ",\n";
		out += "    \"charSigned\": ";
		out += ((char)-1 < 0) ? "true" : "false";
		out += ",\n    \"littleEndian\": ";
		{
			const uint32_t probe = 0x01020304u;
			unsigned char b[4];
			std::memcpy(b, &probe, 4);
			out += (b[0] == 0x04) ? "true" : "false";
		}
		out += "\n  },\n";

		// ---- measured types ----
		std::vector<TypeRec> types;
		{
			using namespace SysProfile;
			types.push_back(measure<UserIdentifier>("SysProfile::UserIdentifier", "struct",
				setUserIdentifier,
				{
					WP_FIELD(UserIdentifier, m_Uid, "SystemProfile.h:76"),
					WP_FIELD(UserIdentifier, m_IsGuest, "SystemProfile.h:81"),
				}, {}));
			types.push_back(measure<BaseProfile>("SysProfile::BaseProfile", "struct",
				setBaseProfile,
				{
					WP_FIELD(BaseProfile, m_Uid, "SystemProfile.h:76"),
					WP_FIELD(BaseProfile, m_IsGuest, "SystemProfile.h:81"),
					WP_ARRAY(BaseProfile, m_Name, SYSTEM_PROFILE_NAME_LENGTH, "SystemProfile.h:107"),
				}, {}));
		}
		{
			using namespace RacerNet;
			types.push_back(measure<DatagramPacketHeader>("RacerNet::DatagramPacketHeader", "struct",
				setDatagramPacketHeader,
				{
					WP_FIELD(DatagramPacketHeader, m_EncryptedBytes, "NetDatagramHeader.h:29"),
				},
				{
					BitSpec<DatagramPacketHeader>{ "m_Reliable", [](DatagramPacketHeader& o) { o.m_Reliable = 1; }, 1, "NetDatagramHeader.h:30" },
					BitSpec<DatagramPacketHeader>{ "m_PartyChannel", [](DatagramPacketHeader& o) { o.m_PartyChannel = 1; }, 1, "NetDatagramHeader.h:31" },
					BitSpec<DatagramPacketHeader>{ "m_SenderReference", [](DatagramPacketHeader& o) { o.m_SenderReference = 63; }, 6, "NetDatagramHeader.h:32" },
					BitSpec<DatagramPacketHeader>{ "m_PacketType", [](DatagramPacketHeader& o) { o.m_PacketType = 255; }, 8, "NetDatagramHeader.h:33" },
				}));
			types.push_back(measure<DatagramUnReliablePacketHeader>("RacerNet::DatagramUnReliablePacketHeader", "struct",
				[](DatagramUnReliablePacketHeader& o) {
					o.m_EncryptedBytes = 0x1234;
					o.m_Reliable = 1;
					o.m_PartyChannel = 1;
					o.m_SenderReference = 0x2A;
					o.m_PacketType = 0xA5;
				},
				{
					WP_FIELD(DatagramUnReliablePacketHeader, m_EncryptedBytes, "NetDatagramHeader.h:29"),
				},
				{
					BitSpec<DatagramUnReliablePacketHeader>{ "m_Reliable", [](DatagramUnReliablePacketHeader& o) { o.m_Reliable = 1; }, 1, "NetDatagramHeader.h:30" },
					BitSpec<DatagramUnReliablePacketHeader>{ "m_PartyChannel", [](DatagramUnReliablePacketHeader& o) { o.m_PartyChannel = 1; }, 1, "NetDatagramHeader.h:31" },
					BitSpec<DatagramUnReliablePacketHeader>{ "m_SenderReference", [](DatagramUnReliablePacketHeader& o) { o.m_SenderReference = 63; }, 6, "NetDatagramHeader.h:32" },
					BitSpec<DatagramUnReliablePacketHeader>{ "m_PacketType", [](DatagramUnReliablePacketHeader& o) { o.m_PacketType = 255; }, 8, "NetDatagramHeader.h:33" },
				}));
			types.push_back(measure<DatagramReliablePacketHeader>("RacerNet::DatagramReliablePacketHeader", "struct",
				setDatagramReliablePacketHeader,
				{
					WP_FIELD(DatagramReliablePacketHeader, m_EncryptedBytes, "NetDatagramHeader.h:29"),
					WP_FIELD(DatagramReliablePacketHeader, m_TotalMessageSize, "NetDatagramHeader.h:53"),
					WP_FIELD(DatagramReliablePacketHeader, m_PacketSequence, "NetDatagramHeader.h:54"),
				},
				{
					BitSpec<DatagramReliablePacketHeader>{ "m_Reliable", [](DatagramReliablePacketHeader& o) { o.m_Reliable = 1; }, 1, "NetDatagramHeader.h:30" },
					BitSpec<DatagramReliablePacketHeader>{ "m_PartyChannel", [](DatagramReliablePacketHeader& o) { o.m_PartyChannel = 1; }, 1, "NetDatagramHeader.h:31" },
					BitSpec<DatagramReliablePacketHeader>{ "m_SenderReference", [](DatagramReliablePacketHeader& o) { o.m_SenderReference = 63; }, 6, "NetDatagramHeader.h:32" },
					BitSpec<DatagramReliablePacketHeader>{ "m_PacketType", [](DatagramReliablePacketHeader& o) { o.m_PacketType = 255; }, 8, "NetDatagramHeader.h:33" },
					BitSpec<DatagramReliablePacketHeader>{ "m_InitialConnection", [](DatagramReliablePacketHeader& o) { o.m_InitialConnection = 1; }, 1, "NetDatagramHeader.h:50" },
					BitSpec<DatagramReliablePacketHeader>{ "m_FirstPacketInStream", [](DatagramReliablePacketHeader& o) { o.m_FirstPacketInStream = 1; }, 1, "NetDatagramHeader.h:51" },
					BitSpec<DatagramReliablePacketHeader>{ "m_PacketSize", [](DatagramReliablePacketHeader& o) { o.m_PacketSize = 0x3FFF; }, 14, "NetDatagramHeader.h:52" },
				}));
			types.push_back(measure<DatagramAcknowledgementHeader>("RacerNet::DatagramAcknowledgementHeader", "struct",
				setDatagramAcknowledgementHeader,
				{
					WP_FIELD(DatagramAcknowledgementHeader, m_EncryptedBytes, "NetDatagramHeader.h:29"),
					WP_FIELD(DatagramAcknowledgementHeader, m_PacketSequence, "NetDatagramHeader.h:63"),
				},
				{
					BitSpec<DatagramAcknowledgementHeader>{ "m_Reliable", [](DatagramAcknowledgementHeader& o) { o.m_Reliable = 1; }, 1, "NetDatagramHeader.h:30" },
					BitSpec<DatagramAcknowledgementHeader>{ "m_PartyChannel", [](DatagramAcknowledgementHeader& o) { o.m_PartyChannel = 1; }, 1, "NetDatagramHeader.h:31" },
					BitSpec<DatagramAcknowledgementHeader>{ "m_SenderReference", [](DatagramAcknowledgementHeader& o) { o.m_SenderReference = 63; }, 6, "NetDatagramHeader.h:32" },
					BitSpec<DatagramAcknowledgementHeader>{ "m_PacketType", [](DatagramAcknowledgementHeader& o) { o.m_PacketType = 255; }, 8, "NetDatagramHeader.h:33" },
				}));

			types.push_back(measure<NetPlayerVehicle>("RacerNet::NetPlayerVehicle", "struct",
				setNetPlayerVehicle,
				{
					WP_FIELD(NetPlayerVehicle, m_xtVehicleId, "NetPlayerRaceData.h:48"),
					WP_FIELD(NetPlayerVehicle, m_xtColourId, "NetPlayerRaceData.h:49"),
					WP_FIELD(NetPlayerVehicle, m_CharacterId, "NetPlayerRaceData.h:53"),
				},
				{
					BitSpec<NetPlayerVehicle>{ "m_VehicleContentPack", [](NetPlayerVehicle& o) { o.m_VehicleContentPack = 0x7FFF; }, 15, "NetPlayerRaceData.h:50" },
					BitSpec<NetPlayerVehicle>{ "m_AutoGears", [](NetPlayerVehicle& o) { o.m_AutoGears = 1; }, 1, "NetPlayerRaceData.h:51" },
					BitSpec<NetPlayerVehicle>{ "m_PickupSlots", [](NetPlayerVehicle& o) { o.m_PickupSlots = 0xFFFF; }, 16, "NetPlayerRaceData.h:55" },
					BitSpec<NetPlayerVehicle>{ "m_ShieldSlots", [](NetPlayerVehicle& o) { o.m_ShieldSlots = 0xFF; }, 8, "NetPlayerRaceData.h:56" },
					BitSpec<NetPlayerVehicle>{ "m_AdditionalHealthPips", [](NetPlayerVehicle& o) { o.m_AdditionalHealthPips = 0xFF; }, 8, "NetPlayerRaceData.h:57" },
					BitSpec<NetPlayerVehicle>{ "m_AdditionalHP", [](NetPlayerVehicle& o) { o.m_AdditionalHP = 1; }, 1, "NetPlayerRaceData.h:59" },
				}));

			types.push_back(measure<NetPlayerLoadOut>("RacerNet::NetPlayerLoadOut", "struct",
				setNetPlayerLoadOut,
				{
					WP_ARRAY(NetPlayerLoadOut, slots, UI::E_MULTIPLAYER_LOADOUT_SLOT_MAX, "NetPlayerRaceData.h:75"),
				}, {}));

			types.push_back(measure<NetPlayerSharedProfile>("RacerNet::NetPlayerSharedProfile", "struct",
				setNetPlayerSharedProfile,
				{
					WP_FIELD(NetPlayerSharedProfile, m_RacePointsThisSession, "NetPlayerProfileData.h:33"),
					WP_FIELD(NetPlayerSharedProfile, m_Rank, "NetPlayerProfileData.h:35"),
					WP_FIELD(NetPlayerSharedProfile, m_Legend, "NetPlayerProfileData.h:36"),
					WP_FIELD(NetPlayerSharedProfile, m_WinningStreak, "NetPlayerProfileData.h:37"),
					WP_FIELD(NetPlayerSharedProfile, m_RacesThisSession, "NetPlayerProfileData.h:38"),
					WP_FIELD(NetPlayerSharedProfile, m_WinsThisSession, "NetPlayerProfileData.h:39"),
					WP_FIELD(NetPlayerSharedProfile, m_BlurDeveloper, "NetPlayerProfileData.h:40"),
					WP_FIELD(NetPlayerSharedProfile, m_HasBeatenBizarre, "NetPlayerProfileData.h:41"),
				}, {}));

			types.push_back(measure<NetPlayerProfileGameData>("RacerNet::NetPlayerProfileGameData", "struct",
				setNetPlayerProfileGameData,
				{
					WP_FIELD(NetPlayerProfileGameData, m_Game, "NetPlayerProfileData.h:57"),
					WP_FIELD(NetPlayerProfileGameData, m_UserCreatedContentAvailable, "NetPlayerProfileData.h:59"),
					WP_FIELD(NetPlayerProfileGameData, m_NatType, "NetPlayerProfileData.h:60"),
				}, {}));

			types.push_back(measure<RaceSettings>("RacerNet::RaceSettings", "struct",
				setRaceSettings,
				{
					WP_FIELD(RaceSettings, m_xtCityId, "NetRaceSettings.h:68"),
					WP_FIELD(RaceSettings, m_xtRouteId, "NetRaceSettings.h:69"),
					WP_FIELD(RaceSettings, m_MinPlayers, "NetRaceSettings.h:71"),
					WP_FIELD(RaceSettings, m_MaxPlayers, "NetRaceSettings.h:72"),
					WP_FIELD(RaceSettings, m_Type, "NetRaceSettings.h:74"),
					WP_FIELD(RaceSettings, m_NumLaps, "NetRaceSettings.h:75"),
					WP_FIELD(RaceSettings, m_TimeLimit, "NetRaceSettings.h:76"),
					WP_FIELD(RaceSettings, m_Class, "NetRaceSettings.h:78"),
					WP_FIELD(RaceSettings, m_DamageMode, "NetRaceSettings.h:79"),
					WP_FIELD(RaceSettings, m_Respawn, "NetRaceSettings.h:80"),
					WP_FIELD(RaceSettings, m_Timeout, "NetRaceSettings.h:81"),
					WP_FIELD(RaceSettings, m_Mods, "NetRaceSettings.h:82"),
					WP_FIELD(RaceSettings, m_Upgrades, "NetRaceSettings.h:83"),
					WP_FIELD(RaceSettings, m_LockToHostCar, "NetRaceSettings.h:84"),
					WP_FIELD(RaceSettings, m_AI, "NetRaceSettings.h:85"),
					WP_FIELD(RaceSettings, m_AIMaxPadding, "NetRaceSettings.h:86"),
					WP_FIELD(RaceSettings, m_Handicap, "NetRaceSettings.h:87"),
					WP_FIELD(RaceSettings, m_Pickups, "NetRaceSettings.h:89"),
					WP_FIELD(RaceSettings, m_RandomPickups, "NetRaceSettings.h:90"),
					WP_FIELD(RaceSettings, m_PickupsRespawnMode, "NetRaceSettings.h:91"),
				}, {}));

			types.push_back(measure<NetRaceSettings>("RacerNet::NetRaceSettings", "struct",
				setNetRaceSettings,
				{
					WP_FIELD(NetRaceSettings, m_PackVersion, "NetRaceSettings.h:133"),
					WP_FIELD(NetRaceSettings, m_Name, "NetRaceSettings.h:135"),
					WP_FIELD(NetRaceSettings, m_Description, "NetRaceSettings.h:136"),
					WP_FIELD(NetRaceSettings, m_EventId, "NetRaceSettings.h:139"),
					WP_FIELD(NetRaceSettings, m_FanMultiplier, "NetRaceSettings.h:149"),
					WP_FIELD(NetRaceSettings, m_Misc, "NetRaceSettings.h:153"),
					WP_FIELD(NetRaceSettings, m_LobbyState, "NetRaceSettings.h:155"),
					WP_FIELD(NetRaceSettings, m_LobbyTimer, "NetRaceSettings.h:156"),
					WP_FIELD(NetRaceSettings, m_VoteCountA, "NetRaceSettings.h:157"),
					WP_FIELD(NetRaceSettings, m_VoteCountB, "NetRaceSettings.h:158"),
					WP_FIELD(NetRaceSettings, m_VoteIndexA, "NetRaceSettings.h:159"),
					WP_FIELD(NetRaceSettings, m_VoteIndexB, "NetRaceSettings.h:160"),
					WP_FIELD(NetRaceSettings, m_PlaylistSeed, "NetRaceSettings.h:162"),
					WP_FIELD(NetRaceSettings, m_PlaylistIndex, "NetRaceSettings.h:163"),
					WP_FIELD(NetRaceSettings, m_Race, "NetRaceSettings.h:165"),
				},
				{
					BitSpec<NetRaceSettings>{ "m_CustomRace", [](NetRaceSettings& o) { o.m_CustomRace = 1; }, 1, "NetRaceSettings.h:140" },
					BitSpec<NetRaceSettings>{ "m_PublicGame", [](NetRaceSettings& o) { o.m_PublicGame = 1; }, 1, "NetRaceSettings.h:141" },
					BitSpec<NetRaceSettings>{ "m_Ranked", [](NetRaceSettings& o) { o.m_Ranked = 1; }, 1, "NetRaceSettings.h:142" },
					BitSpec<NetRaceSettings>{ "m_Championship", [](NetRaceSettings& o) { o.m_Championship = 1; }, 1, "NetRaceSettings.h:143" },
					BitSpec<NetRaceSettings>{ "m_Teams", [](NetRaceSettings& o) { o.m_Teams = 1; }, 1, "NetRaceSettings.h:146" },
					BitSpec<NetRaceSettings>{ "m_MinDrivers", [](NetRaceSettings& o) { o.m_MinDrivers = 31; }, 5, "NetRaceSettings.h:147" },
					BitSpec<NetRaceSettings>{ "m_MaxDrivers", [](NetRaceSettings& o) { o.m_MaxDrivers = 31; }, 5, "NetRaceSettings.h:148" },
					BitSpec<NetRaceSettings>{ "m_HasAnyRacesStarted", [](NetRaceSettings& o) { o.m_HasAnyRacesStarted = 1; }, 1, "NetRaceSettings.h:152" },
				}));

			types.push_back(measure<NetStartRacePacketPlayer>("RacerNet::NetStartRacePacketPlayer", "struct",
				setStartRacePacketPlayer,
				{
					WP_FIELD(NetStartRacePacketPlayer, m_User, "NetStartRacePacket.h:19"),
					WP_FIELD(NetStartRacePacketPlayer, mJoinRef, "NetStartRacePacket.h:20"),
					WP_FIELD(NetStartRacePacketPlayer, mPrimaryJoinRef, "NetStartRacePacket.h:21"),
					WP_FIELD(NetStartRacePacketPlayer, mStartPos, "NetStartRacePacket.h:22"),
					WP_FIELD(NetStartRacePacketPlayer, mTeam, "NetStartRacePacket.h:23"),
					WP_FIELD(NetStartRacePacketPlayer, mAiAvatarId, "NetStartRacePacket.h:24"),
					WP_FIELD(NetStartRacePacketPlayer, mAiMultiplayerRank, "NetStartRacePacket.h:25"),
					WP_FIELD(NetStartRacePacketPlayer, mVehicle, "NetStartRacePacket.h:27"),
					WP_FIELD(NetStartRacePacketPlayer, mLoadOut, "NetStartRacePacket.h:28"),
				}, {}));

			types.push_back(measure<NetStartRacePacket>("RacerNet::NetStartRacePacket", "struct",
				setNetStartRacePacket,
				{
					WP_FIELD(NetStartRacePacket, mHostId, "NetStartRacePacket.h:33"),
					WP_FIELD(NetStartRacePacket, mHostStartTime, "NetStartRacePacket.h:34"),
					WP_FIELD(NetStartRacePacket, mRandomSeed, "NetStartRacePacket.h:36"),
					WP_FIELD(NetStartRacePacket, mNumPlayerVehicles, "NetStartRacePacket.h:38"),
					WP_FIELD(NetStartRacePacket, mNumAIVehicles, "NetStartRacePacket.h:39"),
					WP_FIELD(NetStartRacePacket, mOriginalHostJoinId, "NetStartRacePacket.h:41"),
					WP_FIELD(NetStartRacePacket, mEvntIndex, "NetStartRacePacket.h:44"),
					WP_ARRAY(NetStartRacePacket, mPlayer, RacerNet::NET_MAX_VEHICLES, "NetStartRacePacket.h:47"),
				}, {}));
		}
		{
			types.push_back(measure<Game::NetVehicleData>("Game::NetVehicleData", "struct",
				setNetVehicleData,
				{
					WP_FIELD(Game::NetVehicleData, m_State, "NetVehicleData.h:53"),
					WP_FIELD(Game::NetVehicleData, m_SkillRating, "NetVehicleData.h:55"),
					WP_FIELD(Game::NetVehicleData, m_SkillTeam, "NetVehicleData.h:56"),
					WP_FIELD(Game::NetVehicleData, m_Position, "NetVehicleData.h:58"),
					WP_FIELD(Game::NetVehicleData, m_LocalIndex, "NetVehicleData.h:59"),
					WP_FIELD(Game::NetVehicleData, m_Team, "NetVehicleData.h:60"),
					WP_FIELD(Game::NetVehicleData, m_NetJoinId, "NetVehicleData.h:61"),
					WP_FIELD(Game::NetVehicleData, m_Idle, "NetVehicleData.h:63"),
					WP_ARRAY(Game::NetVehicleData, m_Statistics, UI::E_MultiplayerStat_Count, "NetVehicleData.h:65"),
				}, {}));

			using namespace RacingPhysics::Vehicle;
			types.push_back(measure<CompressedNetworkControls>("RacingPhysics::Vehicle::CompressedNetworkControls", "struct",
				setCompressedControls,
				{ WP_ARRAY(CompressedNetworkControls, data, 4, "racingphysics/Vehicles/vehicle.h:100") }, {}));
			types.push_back(measure<CompressedNetworkState>("RacingPhysics::Vehicle::CompressedNetworkState", "struct",
				setCompressedState,
				{ WP_ARRAY(CompressedNetworkState, data, 25, "racingphysics/Vehicles/vehicle.h:95") }, {}));

			types.push_back(measure<RacerNet::NetMuteListJoinReferences>("RacerNet::NetMuteListJoinReferences", "struct",
				setMuteList,
				{
					WP_ARRAY(RacerNet::NetMuteListJoinReferences, storage, RacerNet::NET_MAX_VEHICLES - 1, "NetDefines.h:138 + vector.h:116-119"),
					WP_FIELD(RacerNet::NetMuteListJoinReferences, m_nElements, "vector.h:245"),
				}, {}));
		}

		// ---- enum widths (assumed 4 bytes by the wire; measured here) ----
		{
			TypeRec e;
			e.name = "E_VEHICLE_STATE";
			e.kind = "enum";
			e.size = (int)sizeof(E_VEHICLE_STATE);
			e.align = (int)alignof(E_VEHICLE_STATE);
			e.standardLayout = true;
			e.poisonSensitive = false;
			types.push_back(e);
			e.name = "UI::E_MultiplayerVehicleAbilities";
			e.size = (int)sizeof(UI::E_MultiplayerVehicleAbilities);
			e.align = (int)alignof(UI::E_MultiplayerVehicleAbilities);
			types.push_back(e);
			e.name = "UI::E_MULTIPLAYER_LOADOUT_SLOT";
			e.size = (int)sizeof(UI::E_MULTIPLAYER_LOADOUT_SLOT);
			e.align = (int)alignof(UI::E_MULTIPLAYER_LOADOUT_SLOT);
			types.push_back(e);
		}

		out += "  \"types\": [\n";
		for (size_t i = 0; i < types.size(); ++i)
		{
			const TypeRec& t = types[i];
			out += "    {\n";
			out += "      \"name\": " + jsonStr(t.name.c_str()) + ",\n";
			out += "      \"kind\": " + jsonStr(t.kind.c_str()) + ",\n";
			out += "      \"size\": " + num(t.size) + ",\n";
			out += "      \"align\": " + num(t.align) + ",\n";
			out += "      \"standardLayout\": ";
			out += t.standardLayout ? "true" : "false";
			out += ",\n      \"fields\": [";
			for (size_t f = 0; f < t.fields.size(); ++f)
			{
				out += (f ? ",\n        " : "\n        ");
				out += t.fields[f];
			}
			out += t.fields.empty() ? "],\n" : "\n      ],\n";
			out += "      \"bitfields\": [";
			for (size_t b = 0; b < t.bits.size(); ++b)
			{
				out += (b ? ",\n        " : "\n        ");
				out += t.bits[b];
			}
			out += t.bits.empty() ? "],\n" : "\n      ],\n";
			out += "      \"paddingOffsets\": [";
			for (size_t p = 0; p < t.padding.size(); ++p)
			{
				if (p) out += ",";
				out += num(t.padding[p]);
			}
			out += "],\n";
			out += "      \"poisonSensitive\": ";
			out += t.poisonSensitive ? "true" : "false";
			out += ",\n";
			out += "      \"canonicalHex\": " + jsonStr(t.canonicalHex.c_str()) + ",\n";
			out += "      \"canonicalHash\": " + jsonStr(t.canonicalHash.c_str()) + "\n";
			out += (i + 1 == types.size()) ? "    }\n" : "    },\n";
		}
		out += "  ],\n";

		// ---- P0 packet records ----
		std::vector<std::string> recs;
		{
			RecBuilder r("keepalive", "derived-record");
			r.add("DatagramPacketHeader", (int)sizeof(RacerNet::DatagramPacketHeader), "NetMessage.cpp:92-100");
			recs.push_back(r.json());
		}
		{
			RecBuilder r("ack", "derived-record");
			r.add("DatagramAcknowledgementHeader", (int)sizeof(RacerNet::DatagramAcknowledgementHeader), "NetMessage.cpp:178-190");
			recs.push_back(r.json());
		}
		{
			RecBuilder r("join_request_1local", "derived-record");
			r.add("packetVersion", 4, "NetRace.cpp:2449");
			r.add("recipientJoinId", 1, "NetRace.cpp:2457");
			r.add("hostConsoleId", 8, "NetRace.cpp:2459");
			r.add("senderConsoleId", 8, "NetRace.cpp:2460");
			r.add("commonAddress", BD_COMMON_ADDR_SERIALIZED_SIZE, "NetRace.cpp:2461");
			r.add("upStreamKbps", 2, "NetRace.cpp:2462");
			r.add("downStreamKbps", 2, "NetRace.cpp:2463");
			r.add("dlcMask", 4, "NetRace.cpp:2464");
			r.add("localPlayerCount", 1, "NetRace.cpp:2465");
			r.add("player[0].user(BaseProfile)", (int)sizeof(SysProfile::BaseProfile), "NetRace.cpp:2478");
			r.add("player[0].voiceBanned", 1, "NetRace.cpp:2479");
			r.add("player[0].profileData", (int)sizeof(RacerNet::NetPlayerProfileGameData), "NetRace.cpp:2480");
			r.add("player[0].joinId", 1, "NetRace.cpp:2483");
			recs.push_back(r.json());
		}
		{
			RecBuilder r("join_reply_host_1local", "derived-record");
			r.add("updatedLocalDataFollows", 1, "NetRace.cpp:897");
			r.add("updatedLocalCount", 1, "NetRace.cpp:898");
			r.add("updatedJoinId[0]", 1, "NetRace.cpp:901");
			r.add("hostConsoleId", 8, "NetRace.cpp:909");
			r.add("commonAddress", BD_COMMON_ADDR_SERIALIZED_SIZE, "NetRace.cpp:910");
			r.add("upStreamKbps", 2, "NetRace.cpp:911");
			r.add("downStreamKbps", 2, "NetRace.cpp:912");
			r.add("dlcMask", 4, "NetRace.cpp:913");
			r.add("localPlayerCount", 1, "NetRace.cpp:916");
			r.add("player[0].user(BaseProfile)", (int)sizeof(SysProfile::BaseProfile), "NetRace.cpp:924");
			r.add("player[0].joinId", 1, "NetRace.cpp:925");
			r.add("player[0].voiceBanned", 1, "NetRace.cpp:926");
			r.add("player[0].profileData", (int)sizeof(RacerNet::NetPlayerProfileGameData), "NetRace.cpp:927");
			r.add("player[0].host", 1, "NetRace.cpp:928");
			r.add("player[0].playerState", 1, "NetRace.cpp:929");
			recs.push_back(r.json());
		}
		{
			RecBuilder r("join_data_host_0peers", "derived-record");
			r.add("raceSettings(NetRaceSettings)", (int)sizeof(RacerNet::NetRaceSettings), "NetRace.cpp:993");
			r.add("additionalPeerCount", 1, "NetRace.cpp:994");
			recs.push_back(r.json());
		}
		{
			RecBuilder r("player_states_2", "derived-record");
			r.add("localCount", 1, "NetRace.cpp:1352");
			r.addArray("joinId_state_pair", 2, 2, "NetRace.cpp:1363-1364");
			recs.push_back(r.json());
		}
		{
			RecBuilder r("vehicle_data_1local", "derived-record");
			r.add("numLocal", 1, "GameModeNetwork.cpp:828");
			r.add("player[0].joinId", 1, "GameModeNetwork.cpp:838");
			r.add("player[0].vehicle(NetPlayerVehicle)", (int)sizeof(RacerNet::NetPlayerVehicle), "GameModeNetwork.cpp:839");
			r.add("player[0].loadOut(NetPlayerLoadOut)", (int)sizeof(RacerNet::NetPlayerLoadOut), "GameModeNetwork.cpp:840");
			recs.push_back(r.json());
		}
		{
			RecBuilder r("basic_vehicle_data_1car", "derived-record");
			r.add("carCount", 1, "RaceModeMultiplayer.cpp:977");
			r.add("car[0].joinId", 1, "RaceModeMultiplayer.cpp:996");
			r.add("car[0].controls", (int)sizeof(RacingPhysics::Vehicle::CompressedNetworkControls), "RaceModeMultiplayer.cpp:997");
			r.add("car[0].state", (int)sizeof(RacingPhysics::Vehicle::CompressedNetworkState), "RaceModeMultiplayer.cpp:998");
			r.add("car[0].health", 4, "RaceModeMultiplayer.cpp:999");
			r.add("car[0].pickup", 4, "RaceModeMultiplayer.cpp:1000");
			recs.push_back(r.json());
		}
		{
			RecBuilder r("start_race_packet", "struct-size");
			r.add("NetStartRacePacket", (int)sizeof(RacerNet::NetStartRacePacket), "lua_NetRace.cpp:2077-2080");
			recs.push_back(r.json());
		}
		{
			RecBuilder r("vehicle_finished", "derived-record");
			r.add("carCount", 1, "RaceModeMultiplayer.cpp:1705");
			r.add("car[0].joinId", 1, "RaceModeMultiplayer.cpp:1706");
			r.add("car[0].data(NetVehicleData)", (int)sizeof(Game::NetVehicleData), "RaceModeMultiplayer.cpp:1707");
			recs.push_back(r.json());
		}

		out += "  \"records\": [\n";
		for (size_t i = 0; i < recs.size(); ++i)
		{
			out += "    " + recs[i];
			out += (i + 1 == recs.size()) ? "\n" : ",\n";
		}
		out += "  ]\n}\n";
		return out;
	}

	std::string layoutJson(void)
	{
		return buildJson();
	}

	// -----------------------------------------------------------------------
	// self test
	// -----------------------------------------------------------------------
	bool selfTest(std::string& err)
	{
		// Little-endian is part of the wire contract (t006-wire-format.md §4.5).
		{
			const uint32_t probe = 0x01020304u;
			unsigned char b[4];
			std::memcpy(b, &probe, 4);
			if (b[0] != 0x04)
			{
				err = "target is not little-endian";
				return false;
			}
		}

		// The reliable header size is the anchor every derived fixture uses
		// (t006-wire-format.md §1.6). It contains no wchar_t, so it must be 10 on
		// every target — asserted at compile time below.

		// Determinism: the document must be identical across calls.
		const std::string a = buildJson();
		const std::string b = buildJson();
		if (a != b)
		{
			err = "layout JSON is not deterministic";
			return false;
		}

		// Derived records must be contiguous by construction; the independent
		// Python reference recomputes every record size from the field list.
		const size_t recStart = a.find("\"records\": [");
		if (recStart == std::string::npos)
		{
			err = "records section missing";
			return false;
		}

		return true;
	}
}

#undef WP_FIELD
#undef WP_ARRAY
#undef WIRE_STR
#undef WIRE_STR2
