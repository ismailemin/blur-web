// T-006b layout probe — traceable copy of the declarations that the game
// copies raw into a network datagram.
//
// This header is a *transcription*, not an inclusion: the engine headers cannot
// be compiled outside the game without the whole platform layer. Every block
// below names the upstream file and line range it came from, and
// tests/check_decls.py re-reads those ranges from the committed upstream tree
// and fails if this file and upstream disagree.
//
// Rules used while copying:
//   * field names, order, types, bit widths and array bounds are unchanged;
//   * constructors are copied only when they initialise storage that ends up on
//     the wire (they matter for the padding-poison measurement);
//   * nothing is added, reordered or "fixed" — a layout difference here would
//     invalidate the whole probe.
//
// Upstream checkout: 5270304b81983b3edbd569ba25235c17bbabd7 (verified by
// tests/check_decls.py, which also prints `git -C upstream/BlurRebuilt rev-parse HEAD`).

#ifndef WIRE_DECLS_H
#define WIRE_DECLS_H

#include <cstddef>
#include <cstring>
#include <cstdint>

// ---------------------------------------------------------------------------
// core/Core.h:267-282 — Mercury core scalar typedefs (the MSVC branch).
// ---------------------------------------------------------------------------
typedef signed long long    S64;
typedef unsigned long long  U64;
typedef signed int          S32;
typedef unsigned int        U32;
typedef signed short        S16;
typedef unsigned short      U16;
typedef signed char         S8;
typedef unsigned char       U8;
typedef double              F64;
typedef float               F32;

// core/Core.h:547
//   typedef wchar_t WCHAR;    // wc,   16-bit UNICODE character
// The comment says 16-bit; the actual width is the compiler's `wchar_t` width,
// which is exactly what this probe measures (2 under MSVC x64 and under
// `-fshort-wchar`, 4 under the default wasm32 ABI).
typedef wchar_t WCHAR;

// ---------------------------------------------------------------------------
// SystemProfile/SystemProfile.h:9-26 — name length and platform selects.
// The PC build takes the `#else` branch (PLATFORM_PS3 and LIVE_ON_WINDOWS are
// not defined for PLATFORM_PC), so SYSTEM_PROFILE_NAME_LENGTH is 16+1.
// ---------------------------------------------------------------------------
#define SYSTEM_PROFILE_NAME_LENGTH (16+1)

// bdLobby/bdLobbyCommon/bdLobbyServicesCommon.h:21-24
//   typedef bdUInt64   bdEntityID;
//   typedef bdEntityID bdOnlineUserID;
// bdPlatform/bdPlatformCoreTypes/bdPlatformCoreTypes.h:62
//   typedef BD_UINT_64 bdUInt64;
typedef unsigned long long bdUInt64;
typedef bdUInt64 bdOnlineUserID;

// ---------------------------------------------------------------------------
// Mercury Btl containers, layout-relevant subset.
//
// btl/Containers/vector.h:34-120  VectorStructure_Array<T,N> — `T storage[N]`,
//   no count member (Size() returns N). Only the `#else` branch at :116-119
//   applies: VECTOR_ARRAY_EXPLICIT_CONSTRUCTION is defined only for CFG_SPEED
//   (:29-31), and CFG_SPEED is not part of this probe's configuration.
// btl/Containers/vector.h:126-246 VectorStructure_Static<T,N> — the array base
//   plus `U32 m_nElements;` at :245.
// btl/Containers/vector.h:846-853  VectorParameters_Static<N> selects the above.
// btl/Containers/vector.h:831-838  VectorParameters_Array<N> selects the array.
// btl/Containers/vector.h:908      Vector<T,P> : P::Structure<T>::Result — adds
//   no data members (only member functions and iterators), so the layout is
//   exactly the structure type.
// ---------------------------------------------------------------------------
namespace Btl
{
	template <typename T, int N>
	struct VectorStructure_Array
	{
		T storage[N];
	};

	template <typename T, int N>
	struct VectorStructure_Static
	{
		T storage[N];
		U32 m_nElements;
	};

	template <int N>
	struct VectorParameters_Static
	{
		template <typename T> struct Structure { typedef VectorStructure_Static<T, N> Result; };
	};

	template <int N>
	struct VectorParameters_Array
	{
		template <typename T> struct Structure { typedef VectorStructure_Array<T, N> Result; };
	};

	// No member functions are needed by the probe; only the data layout is
	// measured, and Vector adds none.
	template <typename T, class Parameters>
	struct Vector : Parameters::template Structure<T>::Result
	{
	};
}

// ---------------------------------------------------------------------------
// Ui/game/Multiplayer/MultiplayerDefines.h:352-416 — the two enumerations whose
// values bound arrays that are sent on the wire.
// ---------------------------------------------------------------------------
namespace UI
{
	// :352-399. Only the element *type* of NetPlayerLoadOut::slots matters for the
	// layout, but the whole enumeration is copied so the probe compiles against
	// the same declaration and not against a stand-in.
	enum E_MultiplayerVehicleAbilities
	{
		E_MultiplayerVehicleAbilities_None = -1,

		E_MultiplayerVehicleAbilities_Iron_Fist = 0,
		E_MultiplayerVehicleAbilities_Jump_The_Gun,
		E_MultiplayerVehicleAbilities_Front_Runner,
		E_MultiplayerVehicleAbilities_Drifter,

		E_MultiplayerVehicleAbilities_Titanium_Armour,
		E_MultiplayerVehicleAbilities_Showy_Flourish,
		E_MultiplayerVehicleAbilities_Stable_Frame,
		E_MultiplayerVehicleAbilities_Battering_Ram,

		E_MultiplayerVehicleAbilities_Decoy_Drop,
		E_MultiplayerVehicleAbilities_Road_Sweeper,
		E_MultiplayerVehicleAbilities_Scrambler,
		E_MultiplayerVehicleAbilities_Splash_Damage,

		E_MultiplayerVehicleAbilities_Shielding_Efficiency,
		E_MultiplayerVehicleAbilities_Safety_Net,
		E_MultiplayerVehicleAbilities_Shielded_Boosters,
		E_MultiplayerVehicleAbilities_Shielded_Bay,

		E_MultiplayerVehicleAbilities_ECM,
		E_MultiplayerVehicleAbilities_Vampiric_Wreck,
		E_MultiplayerVehicleAbilities_Bribe,
		E_MultiplayerVehicleAbilities_Fan_Favourite,

		E_MultiplayerVehicleAbilities_Laser_Sight,
		E_MultiplayerVehicleAbilities_Silent_Running,
		E_MultiplayerVehicleAbilities_Last_Gasp,
		E_MultiplayerVehicleAbilities_Mastermine,

		E_MultiplayerVehicleAbilities_Boss_AdditionalShockDomes,
		E_MultiplayerVehicleAbilities_Boss_AdditionalBlindfireShots,
		E_MultiplayerVehicleAbilities_Boss_DoubleShield,
		E_MultiplayerVehicleAbilities_Boss_FansNitroGift,
		E_MultiplayerVehicleAbilities_Boss_NitroRift,
		E_MultiplayerVehicleAbilities_Boss_RepairBonus,
		E_MultiplayerVehicleAbilities_Boss_ShotgunBlindfire,
		E_MultiplayerVehicleAbilities_Boss_ShuntDamage,

		// these aren't currently used - need to be at the bottom so textures still line up
		E_MultiplayerVehicleAbilities_Advanced_Radar,

		E_MultiplayerVehicleAbilities_NumberOfAbilities,
	};

	// :410-416
	enum E_MULTIPLAYER_LOADOUT_SLOT
	{
		E_MULTIPLAYER_LOADOUT_SLOT1,
		E_MULTIPLAYER_LOADOUT_SLOT2,
		E_MULTIPLAYER_LOADOUT_SLOT3,
		E_MULTIPLAYER_LOADOUT_SLOT_MAX,
	};

	// :431-483. Copied verbatim so E_MultiplayerStat_Count is the compiler's
	// value, not a number typed into the probe.
	enum E_MultiplayerStat
	{
		E_MultiplayerStat_RaceTime,
		E_MultiplayerStat_FastestLap,
		E_MultiplayerStat_SlowestLap,
		E_MultiplayerStat_Fans,
		E_MultiplayerStat_HealthRemaining,
		E_MultiplayerStat_LogicPositionCombined,
		E_MultiplayerStat_DistanceTravelled,
		E_MultiplayerStat_LapsCompleted,
		E_MultiplayerStat_OnTrackPoints,
		E_MultiplayerStat_EliminationPoints,
		E_MultiplayerStat_PowerupHits,
		E_MultiplayerStat_HitsByPowerups,
		E_MultiplayerStat_KillStreak,
		E_MultiplayerStat_DeathStreak,
		E_MultiplayerStat_Accuracy,
		E_MultiplayerStat_LongestChain,
		E_MultiplayerStat_PowerupsEvaded,
		E_MultiplayerStat_TopSpeed,
		E_MultiplayerStat_Car2CarAggressiveHits,
		E_MultiplayerStat_Car2CarVictimHits,
		E_MultiplayerStat_EnvironmentalCrashes,
		E_MultiplayerStat_PickupsCollected,
		E_MultiplayerStat_LongestDrift,
		E_MultiplayerStat_TimesInWater,
		E_MultiplayerStat_TimesOffEdge,
		E_MultiplayerStat_DamageDealt,
		E_MultiplayerStat_LongestTimeWithoutBeingWrecked,
		E_MultiplayerStat_TotalCarsWrecked,
		E_MultiplayerStat_TimesHit,
		E_MultiplayerStat_MinesFragmentedWithMastermine,
		E_MultiplayerStat_TimeInvisibleWithSilentRunning,
		E_MultiplayerStat_PowerupsAbsorbedWithSafetyNet,
		E_MultiplayerStat_PlayersScrambled,
		E_MultiplayerStat_PlayersHitwithDecoys,
		E_MultiplayerStat_CarsBatteringRammed,
		E_MultiplayerStat_TimesProtectedByStableFrame,
		E_MultiplayerStat_PlayersHitWithIronFist,
		E_MultiplayerStat_PowerupsDropped,
		E_MultiplayerStat_LongestTimeNotDamaged,
		E_MultiplayerStat_TimeInFirstPlace,
		E_MultiplayerStat_LongestJump,
		E_MultiplayerStat_PlayersHitWithBarge,
		E_MultiplayerStat_NitroOvertakes,
		E_MultiplayerStat_BlockedPowerups,
		E_MultiplayerStat_PowerupsShielded,
		E_MultiplayerStat_PlayersHitWithMine,
		E_MultiplayerStat_PlayersHitWithShunt,
		E_MultiplayerStat_PlayersHitWithBolt,

		E_MultiplayerStat_Count,
	};
}

// ---------------------------------------------------------------------------
// mercury/library/network/include/SystemProfile/SystemProfile.h:45-108
// PC branch (`#else` at :70-79): m_Uid is a bdOnlineUserID (8 bytes).
// ---------------------------------------------------------------------------
namespace SysProfile
{
	struct UserIdentifier
	{
		UserIdentifier()
		{
			m_Uid = 0;
			m_IsGuest = false;
		}
		bdOnlineUserID m_Uid;	// demonware user id
		// is this user flagged as a guest.
		bool	m_IsGuest;
	};

	struct BaseProfile : UserIdentifier
	{
		BaseProfile()
		{
			memset(m_Name, 0, sizeof(m_Name));
		}
		WCHAR*	Name(void) const {return (WCHAR*)m_Name;}
		WCHAR	m_Name[SYSTEM_PROFILE_NAME_LENGTH];
	};
}

// ---------------------------------------------------------------------------
// Network/Misc/NetDatagramHeader.h:24-64
// ---------------------------------------------------------------------------
namespace RacerNet
{
	struct DatagramPacketHeader
	{
		DatagramPacketHeader() : m_EncryptedBytes(0), m_Reliable(0), m_PartyChannel(0), m_PacketType(0), m_SenderReference(0)
		{};

		U16 m_EncryptedBytes;		// must be the first 2 bytes in the data for every datagram we send !!!!
		U16	m_Reliable:1;
		U16 m_PartyChannel:1;
		U16	m_SenderReference:6;
		U16	m_PacketType:8;
	};

	struct DatagramUnReliablePacketHeader : public DatagramPacketHeader
	{
		DatagramUnReliablePacketHeader() {};
	};

	struct DatagramReliablePacketHeader : public DatagramPacketHeader
	{
		DatagramReliablePacketHeader() :	m_InitialConnection(0), m_FirstPacketInStream(0),
											m_PacketSequence(0), m_PacketSize(0), m_TotalMessageSize(0)
		{m_Reliable = 1;}

		U16 m_InitialConnection:1;
		U16 m_FirstPacketInStream:1;
		U16 m_PacketSize:14;
		U16	m_TotalMessageSize;
		U16	m_PacketSequence;
	};

	struct DatagramAcknowledgementHeader : public DatagramPacketHeader
	{
		DatagramAcknowledgementHeader() : m_PacketSequence(0)
		{}

		U16	m_PacketSequence;
	};
}

// ---------------------------------------------------------------------------
// Network/Player/Data/NetPlayerRaceData.h:29-76
// ---------------------------------------------------------------------------
namespace RacerNet
{
	struct NetPlayerVehicle
	{
		NetPlayerVehicle() { Flush(); }

		void Flush(void)
		{
			m_xtVehicleId = 0;
			m_xtColourId = 0;
			m_VehicleContentPack = 0;
			m_AutoGears = 1;

			m_CharacterId = 0;

			m_PickupSlots = 0;
			m_ShieldSlots = 0;
			m_AdditionalHealthPips = 0;
			m_AdditionalHP= 0;
		}

		U32	m_xtVehicleId;
		U32	m_xtColourId;
		U16	m_VehicleContentPack:15;
		U16 m_AutoGears:1;

		U32	m_CharacterId;

		U32 m_PickupSlots			:	16;
		U32 m_ShieldSlots			:	8;
		U32 m_AdditionalHealthPips	:	8;

		U32 m_AdditionalHP          :   1;
	};

	struct NetPlayerLoadOut
	{
		NetPlayerLoadOut() { Flush(); }

		void Flush(void)
		{
			for(int i = 0; i < UI::E_MULTIPLAYER_LOADOUT_SLOT_MAX; i++)
			{
				slots.storage[i] = UI::E_MultiplayerVehicleAbilities_None;
			}
		}

		Btl::Vector< UI::E_MultiplayerVehicleAbilities, Btl::VectorParameters_Array< UI::E_MULTIPLAYER_LOADOUT_SLOT_MAX > > slots;
	};
}

// ---------------------------------------------------------------------------
// Network/Player/Data/NetPlayerProfileData.h:24-61
// ---------------------------------------------------------------------------
namespace RacerNet
{
	struct NetPlayerSharedProfile
	{
		NetPlayerSharedProfile() { Flush(); }
		void Flush(void)
		{
			m_Rank = 0;
			m_Legend = 0;
		}

		U16 m_RacePointsThisSession;

		U8	m_Rank;
		U8	m_Legend;
		U8	m_WinningStreak;
		U8	m_RacesThisSession;
		U8	m_WinsThisSession;
		bool m_BlurDeveloper;
		bool m_HasBeatenBizarre;
	};

	struct NetPlayerProfileGameData
	{
		NetPlayerProfileGameData() { Flush(); }
		void Flush(void)
		{
			m_Game.Flush();
			m_UserCreatedContentAvailable = 0;
			m_NatType = 1;
		}

		NetPlayerSharedProfile	m_Game;

		U8	m_UserCreatedContentAvailable;
		U8	m_NatType;
	};
}

// ---------------------------------------------------------------------------
// Network/Misc/NetDefines.h:46,138 and Network/Misc/NetRaceSettings.h:24-166
// ---------------------------------------------------------------------------
namespace RacerNet
{
	const U8 NET_MAX_VEHICLES = (20);

	typedef Btl::Vector<U8, Btl::VectorParameters_Static<NET_MAX_VEHICLES-1> > NetMuteListJoinReferences;

	const U8 NET_MAX_RACES = 10;
	const U8 NET_RACE_MAX_RULES = 4;

	// NetRaceSettings.h:27-31
	struct Rule
	{
		U32	m_xtRuleId;
		S32	m_Value;
	};

	// NetRaceSettings.h:33-92
	struct RaceSettings
	{
		RaceSettings() { Clear(); }

		void Clear()
		{
			m_xtCityId		= 0;
			m_xtRouteId		= 0;
			m_MinPlayers	= 2;
			m_MaxPlayers	= 20;
			m_Type			= 0;
			m_NumLaps		= 1;
			m_TimeLimit		= 0;
			m_Class			= 0;
			m_DamageMode	= 0;
			m_Respawn		= 0;
			m_Timeout		= 0;
			m_Mods			= 0;
			m_Upgrades		= 0;
			m_LockToHostCar = 0;
			m_AI			= 0;
			m_AIMaxPadding	= 0;
			m_Handicap		= 0;
			m_Pickups			 = (U16)0xffff;
			m_RandomPickups		 = 0;
			m_PickupsRespawnMode = 0;
		}

		U32	m_xtCityId;
		U32	m_xtRouteId;
		U8	m_MinPlayers;
		U8	m_MaxPlayers;
		S8	m_Type;
		S8	m_NumLaps;
		S32	m_TimeLimit;
		S8	m_Class;
		S8	m_DamageMode;
		S8	m_Respawn;
		S8	m_Timeout;
		S8	m_Mods;
		S8	m_Upgrades;
		S8	m_LockToHostCar;
		S8	m_AI;
		S8	m_AIMaxPadding;
		S8	m_Handicap;
		U16	m_Pickups;
		S8	m_RandomPickups;
		S8	m_PickupsRespawnMode;
	};

	// NetRaceSettings.h:97-166
	struct NetRaceSettings
	{
		NetRaceSettings() { Clear(); }

		void Clear()
		{
			m_PackVersion			= 0;
			m_Name					= 0;
			m_Description			= 0;
			m_EventId				= 0;
			m_CustomRace			= 0;
			m_PublicGame			= 1;
			m_Ranked				= 0;
			m_Championship			= 0;
			m_Teams					= 0;
			m_MinDrivers			= 2;
			m_MaxDrivers			= NET_MAX_VEHICLES;
			m_FanMultiplier			= 1.0f;
			m_Misc					= 0xff;
			m_HasAnyRacesStarted	= 0;
			m_LobbyState			= 0;
			m_LobbyTimer			= 0.0f;
			m_VoteCountA			= 0;
			m_VoteCountB			= 0;
			m_VoteIndexA			= -1;
			m_VoteIndexB			= -1;
			m_PlaylistSeed			= 0;
			m_PlaylistIndex			= 0;
		}

		U16 m_PackVersion;

		U32 m_Name;
		U32 m_Description;

		U32	m_EventId;
		U8	m_CustomRace:1;
		U8	m_PublicGame:1;
		U8	m_Ranked:1;
		U8	m_Championship:1;

		U8	m_Teams:1;
		U8	m_MinDrivers:5;
		U8	m_MaxDrivers:5;
		F32 m_FanMultiplier;

		U8	m_HasAnyRacesStarted:1;
		U16	m_Misc;

		S8	m_LobbyState;
		F32	m_LobbyTimer;
		S8	m_VoteCountA;
		S8	m_VoteCountB;
		S16	m_VoteIndexA;
		S16	m_VoteIndexB;

		U32 m_PlaylistSeed;
		S16	m_PlaylistIndex;

		RaceSettings m_Race;
	};
}

// ---------------------------------------------------------------------------
// GameLogic/Structures/NetStartRacePacket.h:17-48
// ---------------------------------------------------------------------------
namespace RacerNet
{
	struct NetStartRacePacketPlayer
	{
		SysProfile::BaseProfile	m_User;
		U8						mJoinRef;
		U8						mPrimaryJoinRef;
		U8						mStartPos;
		U8						mTeam;
		S8						mAiAvatarId;
		U8						mAiMultiplayerRank;

		NetPlayerVehicle		mVehicle;
		NetPlayerLoadOut		mLoadOut;
	};

	struct NetStartRacePacket
	{
		U64 mHostId;
		U32 mHostStartTime;
		U32	mRandomSeed;
		U8	mNumPlayerVehicles;
		U8	mNumAIVehicles;
		U8	mOriginalHostJoinId;
		U8 mEvntIndex;
		Btl::Vector<NetStartRacePacketPlayer, Btl::VectorParameters_Array<RacerNet::NET_MAX_VEHICLES> >	mPlayer;
	};
}

// ---------------------------------------------------------------------------
// GameLogic/Structures/LevelState.h:49-61
// ---------------------------------------------------------------------------
enum E_VEHICLE_STATE
{
	E_VEHICLE_STATE_UNKNOWN,
	E_VEHICLE_STATE_RACING,
	E_VEHICLE_STATE_FINISHED,
	E_VEHICLE_STATE_TIMED_OUT,
	E_VEHICLE_STATE_LEFT_RACE,
	E_VEHICLE_STATE_ELIMINATED,
	E_VEHICLE_STATE_FATALLY_DAMAGED,
	E_VEHICLE_STATE_WAITING_TO_START,

	E_VEHICLE_STATE_MAX,
};

// ---------------------------------------------------------------------------
// GameLogic/Structures/NetVehicleData.h:18-66
// ---------------------------------------------------------------------------
namespace Game
{
	struct NetVehicleData
	{
		E_VEHICLE_STATE								m_State;
		S32											m_SkillRating;
		S32											m_SkillTeam;
		S8											m_Position;
		S8											m_LocalIndex;
		U8											m_Team;
		U8											m_NetJoinId;
		bool										m_Idle;
		Btl::Vector<F32, Btl::VectorParameters_Array<UI::E_MultiplayerStat_Count> > m_Statistics;
	};
}

// ---------------------------------------------------------------------------
// racingphysics/Vehicles/vehicle.h:93-101 — already plain byte arrays.
// ---------------------------------------------------------------------------
namespace RacingPhysics
{
	namespace Vehicle
	{
		struct CompressedNetworkState
		{
			U8 data[25];
		};

		struct CompressedNetworkControls
		{
			U8 data[4];
		};
	}
}

#endif // WIRE_DECLS_H
