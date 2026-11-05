"""T-006b layout probe — independent reference model.

Recomputes sizeof / alignof / field offsets / bitfield positions for the wire
types from their *declarations*, using a layout algorithm written here and
sharing no code with the C++ probe. If the C++ probe and this model disagree,
one of them is wrong; that is the point.

It is parameterised by the size of wchar_t, so the same model produces the
MSVC x64 expectation (2) and the default wasm32 expectation (4).

    python probes/net-layout/tests/reference_layout.py --wchar 2 --out ref2.json
    python probes/net-layout/tests/reference_layout.py --wchar 4 --out ref4.json

Scope: layout only. The canonical byte images and their hashes are produced by
the C++ probe; this model deliberately does not predict them.
"""
from __future__ import annotations

import argparse
import json
import sys

# ---------------------------------------------------------------------------
# scalar types: name -> (size, align)
# ---------------------------------------------------------------------------
SCALARS = {
    'u8': (1, 1),
    's8': (1, 1),
    'bool': (1, 1),
    'u16': (2, 2),
    's16': (2, 2),
    'u32': (4, 4),
    's32': (4, 4),
    'f32': (4, 4),
    'u64': (8, 8),
    'enum': (4, 4),      # unscoped enum, no -fshort-enums: 4 bytes on both targets
}

F = 'field'
B = 'bits'

# Selected by --abi; kept module-level so every nested type in build_all() picks
# it up without threading it through twenty call sites.
ABI = 'msvc'


def align_up(value: int, alignment: int) -> int:
    if alignment <= 1:
        return value
    return (value + alignment - 1) // alignment * alignment


class Type:
    def __init__(self, name: str):
        self.name = name
        self.size = 0
        self.align = 1
        self.dsize = 0                      # end of the last declared field, before tail padding
        self.fields: list[dict] = []      # name, offset, size, count
        self.bits: list[dict] = []        # name, width, firstBit, byteOffset, spanBytes
        self.padding: list[int] = []
        self.occupied: set[int] = set()


def field(name, type_name, count=1):
    return (F, name, type_name, count)


def bitfield(name, unit, width):
    return (B, name, unit, width)


def build(name: str, decls, types: dict[str, Type], wchar: int, base: str | None = None,
          abi: str | None = None) -> Type:
    """Lay out one type following the ABI rules MSVC x64 (abi='msvc') and the
    Itanium/dsize rules Emscripten wasm32 uses (abi='itanium'): each member is
    placed at the next offset aligned to its own alignment; the struct size is
    rounded up to the struct alignment; bitfields of the same declared integer
    type allocate from the least-significant bit of a unit of that type, start
    a new aligned unit when the next field does not fit, and may cross byte
    boundaries inside their unit.

    The two ABIs differ in one place that matters here: where the members of a
    derived class start. MSVC starts them at the base *size* (tail padding is
    kept); Itanium starts them at the base *dsize* (tail padding is reused)."""
    abi = abi or ABI
    t = Type(name)
    offset = 0
    if base is not None:
        b = types[base]
        start = b.dsize if abi == 'itanium' else b.size
        t.align = b.align
        # Inherited members keep their offsets; only the base's *declared*
        # members are occupied, so the base tail padding still shows up as
        # padding of the derived type (as the C++ probe reports it).
        for bf in b.fields:
            t.fields.append(dict(bf))
            for i in range(bf['size']):
                t.occupied.add(bf['offset'] + i)
        t.start_offset = start
    else:
        t.start_offset = 0
    offset = t.start_offset
    unit_start = None      # byte offset of the open bitfield allocation unit
    unit_bytes = 0
    unit_bits = 0
    unit_used = 0

    def close_unit():
        nonlocal unit_start, unit_bits, unit_used, unit_bytes
        unit_start = None
        unit_bits = 0
        unit_used = 0
        unit_bytes = 0

    for decl in decls:
        if decl[0] == F:
            _, fname, type_name, count = decl
            close_unit()
            if type_name in SCALARS:
                esize, ealign = SCALARS[type_name]
            elif type_name == 'wchar':
                esize, ealign = wchar, wchar
            else:
                nested = types[type_name]
                esize, ealign = nested.size, nested.align
            offset = align_up(offset, ealign)
            t.fields.append({'name': fname, 'offset': offset, 'size': esize * count, 'count': count})
            for i in range(esize * count):
                t.occupied.add(offset + i)
            offset += esize * count
            t.align = max(t.align, ealign)
        else:
            _, bname, unit, width = decl
            usize = SCALARS[unit][0]
            ualign = SCALARS[unit][1]
            if unit_start is not None and unit_bytes == usize and unit_used + width <= usize * 8:
                pass  # still fits in the open unit
            else:
                offset = align_up(offset, ualign)
                unit_start = offset
                unit_bytes = usize
                unit_bits = usize * 8
                unit_used = 0
                offset += usize
                t.align = max(t.align, ualign)
            first_bit = unit_start * 8 + unit_used
            # Only the bytes that carry this field's bits are occupied; unused
            # bits of the allocation unit stay padding, exactly as the C++ probe
            # measures them from the byte image.
            first_used_byte = unit_start + (unit_used // 8)
            last_used_byte = unit_start + ((unit_used + width - 1) // 8)
            for byte in range(first_used_byte, last_used_byte + 1):
                t.occupied.add(byte)
            t.bits.append({
                'name': bname,
                'width': width,
                'firstBit': first_bit,
                'byteOffset': first_used_byte,
                'spanBytes': last_used_byte - first_used_byte + 1,
            })
            unit_used += width

    t.size = align_up(offset, t.align)
    t.dsize = (max(t.occupied) + 1) if t.occupied else 0
    t.padding = [i for i in range(t.size) if i not in t.occupied]
    return t


def build_all(wchar: int) -> dict[str, Type]:
    types: dict[str, Type] = {}

    # SystemProfile/SystemProfile.h:45-82, PC branch
    types['SysProfile::UserIdentifier'] = build(
        'SysProfile::UserIdentifier',
        [field('m_Uid', 'u64'), field('m_IsGuest', 'bool')], types, wchar)

    # SystemProfile.h:88-108
    types['SysProfile::BaseProfile'] = build(
        'SysProfile::BaseProfile',
        [field('m_Name', 'wchar', 17)],
        types, wchar, base='SysProfile::UserIdentifier')

    # NetDatagramHeader.h:24-34
    types['RacerNet::DatagramPacketHeader'] = build(
        'RacerNet::DatagramPacketHeader',
        [field('m_EncryptedBytes', 'u16'),
         bitfield('m_Reliable', 'u16', 1),
         bitfield('m_PartyChannel', 'u16', 1),
         bitfield('m_SenderReference', 'u16', 6),
         bitfield('m_PacketType', 'u16', 8)],
        types, wchar)

    types['RacerNet::DatagramUnReliablePacketHeader'] = build(
        'RacerNet::DatagramUnReliablePacketHeader',
        [field('m_EncryptedBytes', 'u16'),
         bitfield('m_Reliable', 'u16', 1),
         bitfield('m_PartyChannel', 'u16', 1),
         bitfield('m_SenderReference', 'u16', 6),
         bitfield('m_PacketType', 'u16', 8)],
        types, wchar)

    # NetDatagramHeader.h:44-55
    types['RacerNet::DatagramReliablePacketHeader'] = build(
        'RacerNet::DatagramReliablePacketHeader',
        [field('m_EncryptedBytes', 'u16'),
         bitfield('m_Reliable', 'u16', 1),
         bitfield('m_PartyChannel', 'u16', 1),
         bitfield('m_SenderReference', 'u16', 6),
         bitfield('m_PacketType', 'u16', 8),
         bitfield('m_InitialConnection', 'u16', 1),
         bitfield('m_FirstPacketInStream', 'u16', 1),
         bitfield('m_PacketSize', 'u16', 14),
         field('m_TotalMessageSize', 'u16'),
         field('m_PacketSequence', 'u16')],
        types, wchar)

    # NetDatagramHeader.h:58-64
    types['RacerNet::DatagramAcknowledgementHeader'] = build(
        'RacerNet::DatagramAcknowledgementHeader',
        [field('m_EncryptedBytes', 'u16'),
         bitfield('m_Reliable', 'u16', 1),
         bitfield('m_PartyChannel', 'u16', 1),
         bitfield('m_SenderReference', 'u16', 6),
         bitfield('m_PacketType', 'u16', 8),
         field('m_PacketSequence', 'u16')],
        types, wchar)

    # NetPlayerRaceData.h:29-60
    types['RacerNet::NetPlayerVehicle'] = build(
        'RacerNet::NetPlayerVehicle',
        [field('m_xtVehicleId', 'u32'),
         field('m_xtColourId', 'u32'),
         bitfield('m_VehicleContentPack', 'u16', 15),
         bitfield('m_AutoGears', 'u16', 1),
         field('m_CharacterId', 'u32'),
         bitfield('m_PickupSlots', 'u32', 16),
         bitfield('m_ShieldSlots', 'u32', 8),
         bitfield('m_AdditionalHealthPips', 'u32', 8),
         bitfield('m_AdditionalHP', 'u32', 1)],
        types, wchar)

    # NetPlayerRaceData.h:63-76 — Btl::Vector<E, VectorParameters_Array<3>> is
    # exactly `enum storage[3]`.
    types['RacerNet::NetPlayerLoadOut'] = build(
        'RacerNet::NetPlayerLoadOut',
        [field('slots', 'enum', 3)], types, wchar)

    # NetPlayerProfileData.h:24-42
    types['RacerNet::NetPlayerSharedProfile'] = build(
        'RacerNet::NetPlayerSharedProfile',
        [field('m_RacePointsThisSession', 'u16'),
         field('m_Rank', 'u8'),
         field('m_Legend', 'u8'),
         field('m_WinningStreak', 'u8'),
         field('m_RacesThisSession', 'u8'),
         field('m_WinsThisSession', 'u8'),
         field('m_BlurDeveloper', 'bool'),
         field('m_HasBeatenBizarre', 'bool')],
        types, wchar)

    # NetPlayerProfileData.h:47-61
    types['RacerNet::NetPlayerProfileGameData'] = build(
        'RacerNet::NetPlayerProfileGameData',
        [field('m_Game', 'RacerNet::NetPlayerSharedProfile'),
         field('m_UserCreatedContentAvailable', 'u8'),
         field('m_NatType', 'u8')],
        types, wchar)

    # NetRaceSettings.h:33-92
    types['RacerNet::RaceSettings'] = build(
        'RacerNet::RaceSettings',
        [field('m_xtCityId', 'u32'),
         field('m_xtRouteId', 'u32'),
         field('m_MinPlayers', 'u8'),
         field('m_MaxPlayers', 'u8'),
         field('m_Type', 's8'),
         field('m_NumLaps', 's8'),
         field('m_TimeLimit', 's32'),
         field('m_Class', 's8'),
         field('m_DamageMode', 's8'),
         field('m_Respawn', 's8'),
         field('m_Timeout', 's8'),
         field('m_Mods', 's8'),
         field('m_Upgrades', 's8'),
         field('m_LockToHostCar', 's8'),
         field('m_AI', 's8'),
         field('m_AIMaxPadding', 's8'),
         field('m_Handicap', 's8'),
         field('m_Pickups', 'u16'),
         field('m_RandomPickups', 's8'),
         field('m_PickupsRespawnMode', 's8')],
        types, wchar)

    # NetRaceSettings.h:97-166
    types['RacerNet::NetRaceSettings'] = build(
        'RacerNet::NetRaceSettings',
        [field('m_PackVersion', 'u16'),
         field('m_Name', 'u32'),
         field('m_Description', 'u32'),
         field('m_EventId', 'u32'),
         bitfield('m_CustomRace', 'u8', 1),
         bitfield('m_PublicGame', 'u8', 1),
         bitfield('m_Ranked', 'u8', 1),
         bitfield('m_Championship', 'u8', 1),
         bitfield('m_Teams', 'u8', 1),
         bitfield('m_MinDrivers', 'u8', 5),
         bitfield('m_MaxDrivers', 'u8', 5),
         field('m_FanMultiplier', 'f32'),
         bitfield('m_HasAnyRacesStarted', 'u8', 1),
         field('m_Misc', 'u16'),
         field('m_LobbyState', 's8'),
         field('m_LobbyTimer', 'f32'),
         field('m_VoteCountA', 's8'),
         field('m_VoteCountB', 's8'),
         field('m_VoteIndexA', 's16'),
         field('m_VoteIndexB', 's16'),
         field('m_PlaylistSeed', 'u32'),
         field('m_PlaylistIndex', 's16'),
         field('m_Race', 'RacerNet::RaceSettings')],
        types, wchar)

    # NetStartRacePacket.h:17-29
    types['RacerNet::NetStartRacePacketPlayer'] = build(
        'RacerNet::NetStartRacePacketPlayer',
        [field('m_User', 'SysProfile::BaseProfile'),
         field('mJoinRef', 'u8'),
         field('mPrimaryJoinRef', 'u8'),
         field('mStartPos', 'u8'),
         field('mTeam', 'u8'),
         field('mAiAvatarId', 's8'),
         field('mAiMultiplayerRank', 'u8'),
         field('mVehicle', 'RacerNet::NetPlayerVehicle'),
         field('mLoadOut', 'RacerNet::NetPlayerLoadOut')],
        types, wchar)

    # NetStartRacePacket.h:31-48
    types['RacerNet::NetStartRacePacket'] = build(
        'RacerNet::NetStartRacePacket',
        [field('mHostId', 'u64'),
         field('mHostStartTime', 'u32'),
         field('mRandomSeed', 'u32'),
         field('mNumPlayerVehicles', 'u8'),
         field('mNumAIVehicles', 'u8'),
         field('mOriginalHostJoinId', 'u8'),
         field('mEvntIndex', 'u8'),
         field('mPlayer', 'RacerNet::NetStartRacePacketPlayer', 20)],
        types, wchar)

    # NetVehicleData.h:18-66
    types['Game::NetVehicleData'] = build(
        'Game::NetVehicleData',
        [field('m_State', 'enum'),
         field('m_SkillRating', 's32'),
         field('m_SkillTeam', 's32'),
         field('m_Position', 's8'),
         field('m_LocalIndex', 's8'),
         field('m_Team', 'u8'),
         field('m_NetJoinId', 'u8'),
         field('m_Idle', 'bool'),
         field('m_Statistics', 'f32', 48)],
        types, wchar)

    # racingphysics/Vehicles/vehicle.h:93-101
    types['RacingPhysics::Vehicle::CompressedNetworkControls'] = build(
        'RacingPhysics::Vehicle::CompressedNetworkControls',
        [field('data', 'u8', 4)], types, wchar)
    types['RacingPhysics::Vehicle::CompressedNetworkState'] = build(
        'RacingPhysics::Vehicle::CompressedNetworkState',
        [field('data', 'u8', 25)], types, wchar)

    # NetDefines.h:138 — Btl::Vector<U8, VectorParameters_Static<19>>
    # = U8 storage[19]; U32 m_nElements;
    types['RacerNet::NetMuteListJoinReferences'] = build(
        'RacerNet::NetMuteListJoinReferences',
        [field('storage', 'u8', 19), field('m_nElements', 'u32')],
        types, wchar)

    return types


ENUM_TYPES = ['E_VEHICLE_STATE',
              'UI::E_MultiplayerVehicleAbilities',
              'UI::E_MULTIPLAYER_LOADOUT_SLOT']

TYPE_ORDER = [
    'SysProfile::UserIdentifier',
    'SysProfile::BaseProfile',
    'RacerNet::DatagramPacketHeader',
    'RacerNet::DatagramUnReliablePacketHeader',
    'RacerNet::DatagramReliablePacketHeader',
    'RacerNet::DatagramAcknowledgementHeader',
    'RacerNet::NetPlayerVehicle',
    'RacerNet::NetPlayerLoadOut',
    'RacerNet::NetPlayerSharedProfile',
    'RacerNet::NetPlayerProfileGameData',
    'RacerNet::RaceSettings',
    'RacerNet::NetRaceSettings',
    'RacerNet::NetStartRacePacketPlayer',
    'RacerNet::NetStartRacePacket',
    'Game::NetVehicleData',
    'RacingPhysics::Vehicle::CompressedNetworkControls',
    'RacingPhysics::Vehicle::CompressedNetworkState',
    'RacerNet::NetMuteListJoinReferences',
]

BD_COMMON_ADDR_SERIALIZED_SIZE = 25   # (3+1)*(4+2)+1, bdCommonAddr.h:42


def build_records(types: dict[str, Type]) -> list[dict]:
    def size_of(name):
        return types[name].size

    records = []

    def add(name, fields):
        out = []
        cursor = 0
        for fname, fsize, count in fields:
            out.append({'name': fname, 'offset': cursor, 'size': fsize, 'count': count})
            cursor += fsize * count
        records.append({'name': name, 'size': cursor, 'fields': out})

    add('keepalive', [('DatagramPacketHeader', size_of('RacerNet::DatagramPacketHeader'), 1)])
    add('ack', [('DatagramAcknowledgementHeader', size_of('RacerNet::DatagramAcknowledgementHeader'), 1)])
    add('join_request_1local', [
        ('packetVersion', 4, 1),
        ('recipientJoinId', 1, 1),
        ('hostConsoleId', 8, 1),
        ('senderConsoleId', 8, 1),
        ('commonAddress', BD_COMMON_ADDR_SERIALIZED_SIZE, 1),
        ('upStreamKbps', 2, 1),
        ('downStreamKbps', 2, 1),
        ('dlcMask', 4, 1),
        ('localPlayerCount', 1, 1),
        ('player[0].user(BaseProfile)', size_of('SysProfile::BaseProfile'), 1),
        ('player[0].voiceBanned', 1, 1),
        ('player[0].profileData', size_of('RacerNet::NetPlayerProfileGameData'), 1),
        ('player[0].joinId', 1, 1),
    ])
    add('join_reply_host_1local', [
        ('updatedLocalDataFollows', 1, 1),
        ('updatedLocalCount', 1, 1),
        ('updatedJoinId[0]', 1, 1),
        ('hostConsoleId', 8, 1),
        ('commonAddress', BD_COMMON_ADDR_SERIALIZED_SIZE, 1),
        ('upStreamKbps', 2, 1),
        ('downStreamKbps', 2, 1),
        ('dlcMask', 4, 1),
        ('localPlayerCount', 1, 1),
        ('player[0].user(BaseProfile)', size_of('SysProfile::BaseProfile'), 1),
        ('player[0].joinId', 1, 1),
        ('player[0].voiceBanned', 1, 1),
        ('player[0].profileData', size_of('RacerNet::NetPlayerProfileGameData'), 1),
        ('player[0].host', 1, 1),
        ('player[0].playerState', 1, 1),
    ])
    add('join_data_host_0peers', [
        ('raceSettings(NetRaceSettings)', size_of('RacerNet::NetRaceSettings'), 1),
        ('additionalPeerCount', 1, 1),
    ])
    add('player_states_2', [('localCount', 1, 1), ('joinId_state_pair', 2, 2)])
    add('vehicle_data_1local', [
        ('numLocal', 1, 1),
        ('player[0].joinId', 1, 1),
        ('player[0].vehicle(NetPlayerVehicle)', size_of('RacerNet::NetPlayerVehicle'), 1),
        ('player[0].loadOut(NetPlayerLoadOut)', size_of('RacerNet::NetPlayerLoadOut'), 1),
    ])
    add('basic_vehicle_data_1car', [
        ('carCount', 1, 1),
        ('car[0].joinId', 1, 1),
        ('car[0].controls', size_of('RacingPhysics::Vehicle::CompressedNetworkControls'), 1),
        ('car[0].state', size_of('RacingPhysics::Vehicle::CompressedNetworkState'), 1),
        ('car[0].health', 4, 1),
        ('car[0].pickup', 4, 1),
    ])
    add('start_race_packet', [('NetStartRacePacket', size_of('RacerNet::NetStartRacePacket'), 1)])
    add('vehicle_finished', [
        ('carCount', 1, 1),
        ('car[0].joinId', 1, 1),
        ('car[0].data(NetVehicleData)', size_of('Game::NetVehicleData'), 1),
    ])
    return records


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--wchar', type=int, required=True, choices=(2, 4))
    parser.add_argument('--abi', type=str, default='msvc', choices=('msvc', 'itanium'))
    parser.add_argument('--out', type=str, required=True)
    args = parser.parse_args()

    global ABI
    ABI = args.abi

    types = build_all(args.wchar)
    doc = {
        'schema': 'blur-wire-layout-ref/1',
        'wcharBytes': args.wchar,
        'abi': args.abi,
        'types': [],
        'records': build_records(types),
    }
    for name in TYPE_ORDER:
        t = types[name]
        doc['types'].append({
            'name': t.name,
            'size': t.size,
            'align': t.align,
            'fields': [
                {'name': f['name'], 'offset': f['offset'], 'size': f['size'], 'count': f['count']}
                for f in t.fields
            ],
            'bitfields': [
                {'name': b['name'], 'width': b['width'], 'firstBit': b['firstBit'],
                 'byteOffset': b['byteOffset'], 'spanBytes': b['spanBytes']}
                for b in t.bits
            ],
            'paddingOffsets': t.padding,
        })
    for name in ENUM_TYPES:
        doc['types'].append({
            'name': name, 'size': 4, 'align': 4, 'fields': [], 'bitfields': [], 'paddingOffsets': [],
        })

    with open(args.out, 'w', encoding='utf-8') as f:
        json.dump(doc, f, indent=2)
        f.write('\n')
    print(f'reference_layout: wchar={args.wchar} wrote {args.out}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
