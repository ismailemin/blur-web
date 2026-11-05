"""T-006b net-layout probe — declaration traceability gate.

src/wire_decls.h is a transcription of engine declarations, not an include. This
script proves the transcription is still faithful: for every field the probe
measures it re-reads the recorded line of the committed upstream tree and checks
the declaration is there, then verifies the checkout is the pinned commit and is
clean.

    python probes/net-layout/tests/check_decls.py
    python probes/net-layout/tests/check_decls.py --verbose

Exit codes: 0 ok, 1 mismatch, 2 upstream missing.
"""
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
UPSTREAM = ROOT / 'upstream' / 'BlurRebuilt'
CODE = UPSTREAM / 'code'
EXPECTED_COMMIT = '5270304b81983b9e3edbd569ba25235c17bbabd7'

# (relative path under upstream/BlurRebuilt/code, 1-based line, expected text)
ANCHORS: list[tuple[str, int, str]] = [
    # --- core types -------------------------------------------------------
    ('mercury/library/common/core/include/core/Core.h', 547, 'typedef wchar_t WCHAR'),
    ('mercury/library/common/core/include/core/Core.h', 270, 'typedef signed int S32'),
    ('mercury/library/common/core/include/core/Core.h', 271, 'typedef unsigned int U32'),
    ('mercury/library/common/core/include/core/Core.h', 274, 'typedef unsigned short U16'),
    ('mercury/library/common/core/include/core/Core.h', 268, 'typedef unsigned long long U64'),

    # --- SystemProfile ----------------------------------------------------
    ('mercury/library/network/include/SystemProfile/SystemProfile.h', 12,
     '#define SYSTEM_PROFILE_NAME_LENGTH (16+1)'),
    ('mercury/library/network/include/SystemProfile/SystemProfile.h', 88,
     'struct BaseProfile : UserIdentifier'),
    ('mercury/library/network/include/SystemProfile/SystemProfile.h', 76, 'bdOnlineUserID m_Uid'),
    ('mercury/library/network/include/SystemProfile/SystemProfile.h', 81, 'bool m_IsGuest'),
    ('mercury/library/network/include/SystemProfile/SystemProfile.h', 107,
     'WCHAR m_Name[SYSTEM_PROFILE_NAME_LENGTH]'),

    # --- datagram headers -------------------------------------------------
    ('amax/library/Network/Misc/NetDatagramHeader.h', 24, 'struct DatagramPacketHeader'),
    ('amax/library/Network/Misc/NetDatagramHeader.h', 29, 'U16 m_EncryptedBytes;'),
    ('amax/library/Network/Misc/NetDatagramHeader.h', 30, 'm_Reliable:1'),
    ('amax/library/Network/Misc/NetDatagramHeader.h', 31, 'm_PartyChannel:1'),
    ('amax/library/Network/Misc/NetDatagramHeader.h', 32, 'm_SenderReference:6'),
    ('amax/library/Network/Misc/NetDatagramHeader.h', 33, 'm_PacketType:8'),
    ('amax/library/Network/Misc/NetDatagramHeader.h', 44, 'struct DatagramReliablePacketHeader'),
    ('amax/library/Network/Misc/NetDatagramHeader.h', 50, 'm_InitialConnection:1'),
    ('amax/library/Network/Misc/NetDatagramHeader.h', 51, 'm_FirstPacketInStream:1'),
    ('amax/library/Network/Misc/NetDatagramHeader.h', 52, 'm_PacketSize:14'),
    ('amax/library/Network/Misc/NetDatagramHeader.h', 53, 'U16 m_TotalMessageSize;'),
    ('amax/library/Network/Misc/NetDatagramHeader.h', 54, 'm_PacketSequence;'),
    ('amax/library/Network/Misc/NetDatagramHeader.h', 58, 'struct DatagramAcknowledgementHeader'),
    ('amax/library/Network/Misc/NetDatagramHeader.h', 63, 'U16 m_PacketSequence;'),

    # --- player race/profile data ----------------------------------------
    ('amax/library/Network/Player/Data/NetPlayerRaceData.h', 29, 'struct NetPlayerVehicle'),
    ('amax/library/Network/Player/Data/NetPlayerRaceData.h', 48, 'U32 m_xtVehicleId;'),
    ('amax/library/Network/Player/Data/NetPlayerRaceData.h', 49, 'U32 m_xtColourId;'),
    ('amax/library/Network/Player/Data/NetPlayerRaceData.h', 50, 'm_VehicleContentPack:15'),
    ('amax/library/Network/Player/Data/NetPlayerRaceData.h', 51, 'm_AutoGears:1'),
    ('amax/library/Network/Player/Data/NetPlayerRaceData.h', 53, 'U32 m_CharacterId;'),
    ('amax/library/Network/Player/Data/NetPlayerRaceData.h', 55, 'm_PickupSlots : 16'),
    ('amax/library/Network/Player/Data/NetPlayerRaceData.h', 56, 'm_ShieldSlots : 8'),
    ('amax/library/Network/Player/Data/NetPlayerRaceData.h', 57, 'm_AdditionalHealthPips : 8'),
    ('amax/library/Network/Player/Data/NetPlayerRaceData.h', 59, 'm_AdditionalHP : 1'),
    ('amax/library/Network/Player/Data/NetPlayerRaceData.h', 63, 'struct NetPlayerLoadOut'),
    ('amax/library/Network/Player/Data/NetPlayerRaceData.h', 75,
     'Btl::Vector< UI::E_MultiplayerVehicleAbilities, Btl::VectorParameters_Array< UI::E_MULTIPLAYER_LOADOUT_SLOT_MAX > > slots;'),
    ('amax/library/Network/Player/Data/NetPlayerProfileData.h', 24, 'struct NetPlayerSharedProfile'),
    ('amax/library/Network/Player/Data/NetPlayerProfileData.h', 33, 'U16 m_RacePointsThisSession;'),
    ('amax/library/Network/Player/Data/NetPlayerProfileData.h', 35, 'U8 m_Rank;'),
    ('amax/library/Network/Player/Data/NetPlayerProfileData.h', 36, 'U8 m_Legend;'),
    ('amax/library/Network/Player/Data/NetPlayerProfileData.h', 37, 'U8 m_WinningStreak;'),
    ('amax/library/Network/Player/Data/NetPlayerProfileData.h', 38, 'U8 m_RacesThisSession;'),
    ('amax/library/Network/Player/Data/NetPlayerProfileData.h', 39, 'U8 m_WinsThisSession;'),
    ('amax/library/Network/Player/Data/NetPlayerProfileData.h', 40, 'bool m_BlurDeveloper;'),
    ('amax/library/Network/Player/Data/NetPlayerProfileData.h', 41, 'bool m_HasBeatenBizarre;'),
    ('amax/library/Network/Player/Data/NetPlayerProfileData.h', 47,
     'struct NetPlayerProfileGameData'),
    ('amax/library/Network/Player/Data/NetPlayerProfileData.h', 57,
     'NetPlayerSharedProfile m_Game;'),
    ('amax/library/Network/Player/Data/NetPlayerProfileData.h', 59,
     'U8 m_UserCreatedContentAvailable;'),
    ('amax/library/Network/Player/Data/NetPlayerProfileData.h', 60, 'U8 m_NatType;'),

    # --- defines ----------------------------------------------------------
    ('amax/library/Network/Misc/NetDefines.h', 46, 'const U8 NET_MAX_VEHICLES = (20);'),
    ('amax/library/Network/Misc/NetDefines.h', 138,
     'typedef Btl::Vector<U8, Btl::VectorParameters_Static<NET_MAX_VEHICLES-1> > NetMuteListJoinReferences;'),

    # --- race settings ----------------------------------------------------
    ('amax/library/Network/Misc/NetRaceSettings.h', 33, 'struct RaceSettings'),
    ('amax/library/Network/Misc/NetRaceSettings.h', 68, 'U32 m_xtCityId;'),
    ('amax/library/Network/Misc/NetRaceSettings.h', 69, 'U32 m_xtRouteId;'),
    ('amax/library/Network/Misc/NetRaceSettings.h', 71, 'U8 m_MinPlayers;'),
    ('amax/library/Network/Misc/NetRaceSettings.h', 72, 'U8 m_MaxPlayers;'),
    ('amax/library/Network/Misc/NetRaceSettings.h', 74, 'S8 m_Type;'),
    ('amax/library/Network/Misc/NetRaceSettings.h', 75, 'S8 m_NumLaps;'),
    ('amax/library/Network/Misc/NetRaceSettings.h', 76, 'S32 m_TimeLimit;'),
    ('amax/library/Network/Misc/NetRaceSettings.h', 78, 'S8 m_Class;'),
    ('amax/library/Network/Misc/NetRaceSettings.h', 89, 'U16 m_Pickups;'),
    ('amax/library/Network/Misc/NetRaceSettings.h', 90, 'S8 m_RandomPickups;'),
    ('amax/library/Network/Misc/NetRaceSettings.h', 91, 'S8 m_PickupsRespawnMode;'),
    ('amax/library/Network/Misc/NetRaceSettings.h', 97, 'struct NetRaceSettings'),
    ('amax/library/Network/Misc/NetRaceSettings.h', 133, 'U16 m_PackVersion;'),
    ('amax/library/Network/Misc/NetRaceSettings.h', 135, 'U32 m_Name;'),
    ('amax/library/Network/Misc/NetRaceSettings.h', 136, 'U32 m_Description;'),
    ('amax/library/Network/Misc/NetRaceSettings.h', 139, 'U32 m_EventId;'),
    ('amax/library/Network/Misc/NetRaceSettings.h', 140, 'm_CustomRace:1'),
    ('amax/library/Network/Misc/NetRaceSettings.h', 141, 'm_PublicGame:1'),
    ('amax/library/Network/Misc/NetRaceSettings.h', 142, 'm_Ranked:1'),
    ('amax/library/Network/Misc/NetRaceSettings.h', 143, 'm_Championship:1'),
    ('amax/library/Network/Misc/NetRaceSettings.h', 146, 'm_Teams:1'),
    ('amax/library/Network/Misc/NetRaceSettings.h', 147, 'm_MinDrivers:5'),
    ('amax/library/Network/Misc/NetRaceSettings.h', 148, 'm_MaxDrivers:5'),
    ('amax/library/Network/Misc/NetRaceSettings.h', 149, 'F32 m_FanMultiplier;'),
    ('amax/library/Network/Misc/NetRaceSettings.h', 152, 'm_HasAnyRacesStarted:1'),
    ('amax/library/Network/Misc/NetRaceSettings.h', 153, 'U16 m_Misc;'),
    ('amax/library/Network/Misc/NetRaceSettings.h', 155, 'S8 m_LobbyState;'),
    ('amax/library/Network/Misc/NetRaceSettings.h', 156, 'F32 m_LobbyTimer;'),
    ('amax/library/Network/Misc/NetRaceSettings.h', 157, 'S8 m_VoteCountA;'),
    ('amax/library/Network/Misc/NetRaceSettings.h', 158, 'S8 m_VoteCountB;'),
    ('amax/library/Network/Misc/NetRaceSettings.h', 159, 'S16 m_VoteIndexA;'),
    ('amax/library/Network/Misc/NetRaceSettings.h', 160, 'S16 m_VoteIndexB;'),
    ('amax/library/Network/Misc/NetRaceSettings.h', 162, 'U32 m_PlaylistSeed;'),
    ('amax/library/Network/Misc/NetRaceSettings.h', 163, 'S16 m_PlaylistIndex;'),
    ('amax/library/Network/Misc/NetRaceSettings.h', 165, 'RaceSettings m_Race;'),

    # --- StartRace --------------------------------------------------------
    ('amax/game/GameLogic/Structures/NetStartRacePacket.h', 17,
     'struct NetStartRacePacketPlayer'),
    ('amax/game/GameLogic/Structures/NetStartRacePacket.h', 19, 'SysProfile::BaseProfile m_User;'),
    ('amax/game/GameLogic/Structures/NetStartRacePacket.h', 20, 'U8 mJoinRef;'),
    ('amax/game/GameLogic/Structures/NetStartRacePacket.h', 21, 'U8 mPrimaryJoinRef;'),
    ('amax/game/GameLogic/Structures/NetStartRacePacket.h', 22, 'U8 mStartPos;'),
    ('amax/game/GameLogic/Structures/NetStartRacePacket.h', 23, 'U8 mTeam;'),
    ('amax/game/GameLogic/Structures/NetStartRacePacket.h', 24, 'S8 mAiAvatarId;'),
    ('amax/game/GameLogic/Structures/NetStartRacePacket.h', 25, 'U8 mAiMultiplayerRank;'),
    ('amax/game/GameLogic/Structures/NetStartRacePacket.h', 27, 'NetPlayerVehicle mVehicle;'),
    ('amax/game/GameLogic/Structures/NetStartRacePacket.h', 28, 'NetPlayerLoadOut mLoadOut;'),
    ('amax/game/GameLogic/Structures/NetStartRacePacket.h', 31, 'struct NetStartRacePacket'),
    ('amax/game/GameLogic/Structures/NetStartRacePacket.h', 33, 'U64 mHostId;'),
    ('amax/game/GameLogic/Structures/NetStartRacePacket.h', 34, 'U32 mHostStartTime;'),
    ('amax/game/GameLogic/Structures/NetStartRacePacket.h', 36, 'U32 mRandomSeed;'),
    ('amax/game/GameLogic/Structures/NetStartRacePacket.h', 38, 'U8 mNumPlayerVehicles;'),
    ('amax/game/GameLogic/Structures/NetStartRacePacket.h', 39, 'U8 mNumAIVehicles;'),
    ('amax/game/GameLogic/Structures/NetStartRacePacket.h', 41, 'U8 mOriginalHostJoinId;'),
    ('amax/game/GameLogic/Structures/NetStartRacePacket.h', 44, 'U8 mEvntIndex;'),
    ('amax/game/GameLogic/Structures/NetStartRacePacket.h', 47, 'mPlayer;'),

    # --- vehicle data (VehicleFinished) ------------------------------------
    ('amax/game/GameLogic/Structures/LevelState.h', 49, 'enum E_VEHICLE_STATE'),
    ('amax/game/GameLogic/Structures/NetVehicleData.h', 18, 'struct NetVehicleData'),
    ('amax/game/GameLogic/Structures/NetVehicleData.h', 53, 'E_VEHICLE_STATE m_State;'),
    ('amax/game/GameLogic/Structures/NetVehicleData.h', 55, 'S32 m_SkillRating;'),
    ('amax/game/GameLogic/Structures/NetVehicleData.h', 56, 'S32 m_SkillTeam;'),
    ('amax/game/GameLogic/Structures/NetVehicleData.h', 58, 'S8 m_Position;'),
    ('amax/game/GameLogic/Structures/NetVehicleData.h', 59, 'S8 m_LocalIndex;'),
    ('amax/game/GameLogic/Structures/NetVehicleData.h', 60, 'U8 m_Team;'),
    ('amax/game/GameLogic/Structures/NetVehicleData.h', 61, 'U8 m_NetJoinId;'),
    ('amax/game/GameLogic/Structures/NetVehicleData.h', 63, 'bool m_Idle;'),
    ('amax/game/GameLogic/Structures/NetVehicleData.h', 65, 'm_Statistics;'),

    # --- compressed vehicle state -----------------------------------------
    ('mercury/library/physics/racingphysics/include/racingphysics/Vehicles/vehicle.h', 93,
     'struct CompressedNetworkState'),
    ('mercury/library/physics/racingphysics/include/racingphysics/Vehicles/vehicle.h', 95,
     'U8 data[25];'),
    ('mercury/library/physics/racingphysics/include/racingphysics/Vehicles/vehicle.h', 98,
     'struct CompressedNetworkControls'),
    ('mercury/library/physics/racingphysics/include/racingphysics/Vehicles/vehicle.h', 100,
     'U8 data[4];'),

    # --- UI enumerations ---------------------------------------------------
    ('amax/library/Ui/game/Multiplayer/MultiplayerDefines.h', 352,
     'enum E_MultiplayerVehicleAbilities'),
    ('amax/library/Ui/game/Multiplayer/MultiplayerDefines.h', 410,
     'enum E_MULTIPLAYER_LOADOUT_SLOT'),
    ('amax/library/Ui/game/Multiplayer/MultiplayerDefines.h', 415,
     'E_MULTIPLAYER_LOADOUT_SLOT_MAX'),
    ('amax/library/Ui/game/Multiplayer/MultiplayerDefines.h', 431, 'enum E_MultiplayerStat'),
    ('amax/library/Ui/game/Multiplayer/MultiplayerDefines.h', 482, 'E_MultiplayerStat_Count'),

    # --- Btl vector layout --------------------------------------------------
    ('mercury/library/common/core/include/btl/Containers/vector.h', 118, 'T storage[N];'),
    ('mercury/library/common/core/include/btl/Containers/vector.h', 245, 'U32 m_nElements;'),
    ('mercury/library/common/core/include/btl/Containers/vector.h', 908, 'class Vector : public'),

    # --- transport constants ------------------------------------------------
    ('vendor/demonware/2.0/bdCore/bdSocket/bdCommonAddr.h', 42,
     'BD_COMMON_ADDR_SERIALIZED_SIZE'),
    ('vendor/demonware/2.0/bdCore/bdSocket/bdAddr.h', 22, 'BD_ADDR_SIZE'),
    ('vendor/demonware/2.0/bdPlatform/bdPlatformSocket/bdInAddr.h', 30, 'BD_IN_ADDR_SIZE'),

    # --- packet writers (field order of the derived records) ---------------
    ('amax/library/Network/Message/NetMessage.cpp', 92, 'DatagramUnReliablePacketHeader hdr;'),
    ('amax/library/Network/Message/NetMessage.cpp', 178, 'DatagramAcknowledgementHeader hdr;'),
    ('amax/library/Network/Core/NetRace.cpp', 897, 'WriteU8(1)'),
    ('amax/library/Network/Core/NetRace.cpp', 909, 'WriteU64(pPrimaryLocalPlayer->m_ConsoleId)'),
    ('amax/library/Network/Core/NetRace.cpp', 916, 'WriteU8(localPlayerCount)'),
    ('amax/library/Network/Core/NetRace.cpp', 924, 'sizeof(pH->m_User)'),
    ('amax/library/Network/Core/NetRace.cpp', 927, 'sizeof(pH->m_ProfileData)'),
    ('amax/library/Network/Core/NetRace.cpp', 993, 'WriteBuffer(&raceSettings, sizeof(raceSettings))'),
    ('amax/library/Network/Core/NetRace.cpp', 994, 'WriteU8((U8)additionalPeers.Size())'),
    ('amax/library/Network/Core/NetRace.cpp', 1352, 'WriteU8(numLocal)'),
    ('amax/library/Network/Core/NetRace.cpp', 1363, 'm_JoinId'),
    ('amax/library/Network/Core/NetRace.cpp', 1364, 'm_PlayerState'),
    ('amax/library/Network/Core/NetRace.cpp', 2449, 'WriteU32(NET_PACKET_VERSION)'),
    ('amax/library/Network/Core/NetRace.cpp', 2457, 'pRecipient->m_RaceConnection.m_JoinId'),
    ('amax/library/Network/Core/NetRace.cpp', 2459, 'WriteU64(JoinGetHostConsoleId())'),
    ('amax/library/Network/Core/NetRace.cpp', 2460, 'WriteU64(pPrimaryLocalPlayer->m_ConsoleId)'),
    ('amax/library/Network/Core/NetRace.cpp', 2461, 'm_CommonAddress, BD_COMMON_ADDR_SERIALIZED_SIZE'),
    ('amax/library/Network/Core/NetRace.cpp', 2465, 'WriteU8(localPlayerCount)'),
    ('amax/library/Network/Core/NetRace.cpp', 2478, 'sizeof(p->m_User)'),
    ('amax/library/Network/Core/NetRace.cpp', 2480, 'sizeof(p->m_ProfileData)'),
    ('amax/library/Network/Core/NetRace.cpp', 2483, 'm_RaceConnection.m_JoinId'),
    ('amax/game/GameLogic/GameModes/GameModeNetwork.cpp', 828, 'WriteU8(numLocal)'),
    ('amax/game/GameLogic/GameModes/GameModeNetwork.cpp', 838, 'm_RaceConnection.m_JoinId'),
    ('amax/game/GameLogic/GameModes/GameModeNetwork.cpp', 839, 'sizeof(pl->m_RaceData.m_VehicleData)'),
    ('amax/game/GameLogic/GameModes/GameModeNetwork.cpp', 840, 'sizeof(pl->m_RaceData.m_LoadOut)'),
    ('amax/game/GameLogic/RaceModes/RaceModeMultiplayer.cpp', 977,
     'WriteU8(localRacingList.Size())'),
    ('amax/game/GameLogic/RaceModes/RaceModeMultiplayer.cpp', 996, 'mCars[localRacingList[i]].mNetJoinId'),
    ('amax/game/GameLogic/RaceModes/RaceModeMultiplayer.cpp', 997, 'sizeof(controls)'),
    ('amax/game/GameLogic/RaceModes/RaceModeMultiplayer.cpp', 998, 'sizeof(state)'),
    ('amax/game/GameLogic/RaceModes/RaceModeMultiplayer.cpp', 999, 'WriteS32'),
    ('amax/game/GameLogic/RaceModes/RaceModeMultiplayer.cpp', 1000, 'WriteU32((U32)currentPickup)'),
    ('amax/game/GameLogic/RaceModes/RaceModeMultiplayer.cpp', 1705, 'WriteU8(1)'),
    ('amax/game/GameLogic/RaceModes/RaceModeMultiplayer.cpp', 1706, 'WriteU8(pLevelState->mCars[index].mNetJoinId)'),
    ('amax/game/GameLogic/RaceModes/RaceModeMultiplayer.cpp', 1707, 'WriteBuffer(&inData, sizeof(NetVehicleData))'),
    ('amax/game/GameLogic/Lua/lua_NetRace.cpp', 2079, 'sizeof'),
]


def normalise(text: str) -> str:
    return ' '.join(text.split())


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--verbose', action='store_true')
    args = parser.parse_args()

    if not (UPSTREAM / '.git').exists():
        print(f'check_decls: upstream checkout not found at {UPSTREAM}', file=sys.stderr)
        return 2

    head = subprocess.check_output(['git', '-C', str(UPSTREAM), 'rev-parse', 'HEAD'],
                                   text=True).strip()
    dirty = subprocess.check_output(['git', '-C', str(UPSTREAM), 'status', '--porcelain'],
                                    text=True).strip()

    failures = 0
    cache: dict[Path, list[str]] = {}
    for rel, line, expected in ANCHORS:
        path = CODE / rel
        if path not in cache:
            cache[path] = path.read_text(encoding='utf-8', errors='replace').splitlines()
        lines = cache[path]
        if line < 1 or line > len(lines):
            print(f'FAIL {rel}:{line}: line does not exist')
            failures += 1
            continue
        actual = normalise(lines[line - 1])
        want = normalise(expected)
        if want not in actual:
            print(f'FAIL {rel}:{line}\n  expected: {want}\n  actual:   {actual}')
            failures += 1
        elif args.verbose:
            print(f'ok   {rel}:{line}  {actual}')

    print(f'check_decls: {len(ANCHORS) - failures}/{len(ANCHORS)} anchors match, '
          f'upstream HEAD {head[:12]}{" (MISMATCH)" if head != EXPECTED_COMMIT else ""}, '
          f'worktree {"clean" if not dirty else "DIRTY"}')

    if head != EXPECTED_COMMIT:
        print(f'check_decls: expected commit {EXPECTED_COMMIT}', file=sys.stderr)
        failures += 1
    if dirty:
        print('check_decls: upstream working tree is not clean', file=sys.stderr)
        failures += 1
    return 0 if failures == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
