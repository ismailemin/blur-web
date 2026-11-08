# Audio bank, entity and event catalog

**Status:** decoded/catalogued and verified; **not** integrated into `e1-drive`.

**Date:** 8 November 2026.

**Scope:** every BAF bank shipped in `root.pak` and `root_streaming.pak`, the 228
`AudioEntityDef`s, the 365 audio `.dat` graphs, the UI/race/power-up event map,
the decoded manifest and the web-consumer integration contract.

**Non-claim:** this is not the retail mixer, not the Ovis runtime and not a
full-game audio implementation. No audio is synthesised or guessed. A wave is
decoded from the retail BAF, or reported `decodable`/`unsupported` with a typed
reason. Streaming music and ambience are catalogued but not decoded.

## 1. Summary

| Measure | Value |
| --- | ---: |
| Audio banks | **193** (126 in `root.pak`, 67 in `root_streaming.pak`) |
| Waves | **2,732** |
| Codecs | `uADPCM4Bit` 2,728; `PCM16` 4 |
| Sample rates | 48 kHz 2,052; 36 kHz 680 |
| Channels | mono 1,899; stereo 833 |
| Loops / one-shots | 1,558 / 1,174 |
| Declared wave payload | 687,049,060 (655.2 MiB) |
| Streaming banks | **19** (music + environment ST banks) |
| `AudioEntityDef` records | **228** in 10 groups; 367 audio objects |
| Audio graphs | **365** `.dat`; 274 contain sound components; 2,601 sound components |
| Mapped events | **334** |
| Event status | decoded **194**, decodable **70**, unsupported **70** |
| Decoded manifest | **220** waves, 31,927,596 (30.4 MiB) |
| Newly decoded | 160 waves, 24,145,406 (23.0 MiB) |
| Reused decoded | 60 waves, 7,782,190 (7.4 MiB) |
| Verifier | **20,613 checks, 0 failures** |

The practical set covers **all UI, race and power-up events** that map to a
shipped non-streaming wave: 44 UI, 71 race, 47 power-up and 12 tyre events are
`decoded`; 14 collision-world material routes reuse the already decoded
`tyre-collision` WAVs. Six engine RPM loops reuse the already decoded P62/P71
WAVs. Nineteen non-streaming music transition one-shots are `decodable`; the
70 music tracks/loops in streaming banks are `unsupported/streaming-container`.

## 2. Sources and method

| Source | Use |
| --- | --- |
| `root.pak` (`packet-zlib`, codec 4) | 126 `\audio\*.baf` banks and 365 `\audio\dat\*.dat` graphs |
| `root_streaming.pak` (raw, codec 1) | 67 `\env_*.baf`, `\menumusic.baf`, `\ingamemusic.baf`, `\ingamecustommusic.baf`, `\vistamusic.baf` |
| `gamedata.pak:\gamedata\xt\audioentities.bin` | 228 `AudioEntityDef` records (FLSK v2) |
| `gamedata.pak:\gamedata\xt\audio.bin` | 367 `AudioObject` names, 228 `AudioEntityProxy`, 11 `AudioEntityGroup` |
| `root.pak:\audio\datbanklists.wbl` | graph -> bank lists for 365 graphs (285 with banks) |
| `upstream` headers/sources | BAF/ADPCM, AOBJ component sizes, `GetLevel`/`GetFrequency`, `E_EffectMaterial` |

The BAF reader parses `BANK`/`WAVE`/`DATA` chunks. Non-streaming banks carry
their `DATA` inline; streaming banks contain only `WAVE` headers and their
sample data lives in an external stream. ADPCM is the retail `uADPCM4Bit`
33-byte/64-sample block decoder, including the retail `mDeltaFader` fade-in and
the header-frame truncation/padding rule. PCM16 (format 3) is catalogued but not
decoded. No file in `game-data`, `upstream` or `probes/e1-drive` is modified.

### 2.1 Status semantics

| Status | Meaning |
| --- | --- |
| `decoded` | A WAV exists in the manifest with SHA-256 and byte size; it was decoded from the named retail wave. |
| `decodable` | The retail wave is located in a non-streaming bank with a supported codec, but no WAV was produced (music transitions, ambience, induction/supercharger). |
| `unsupported` | The wave cannot be decoded in this slice; `reason` is typed: `streaming-container`, `codec-not-implemented`, `bank-or-wave-not-shipped`, `component-not-found`, `graph-not-shipped`. |

A BAF wave has **no serialised UID**. The stable identifier used here is
`bankName#waveIndex:waveName`, always paired with the bank SHA-256, the
`dataStart` offset and the `dataLength`. That triple is the provenance key.

## 3. Bank inventory

### 3.1 Totals by family

| Family | Banks | Waves | Loops | Streaming banks |
| --- | ---: | ---: | ---: | ---: |
| UI / voice | 11 | 599 | 54 | 0 |
| dynamic object | 50 | 149 | 4 | 0 |
| environment | 63 | 193 | 98 | 15 |
| music | 8 | 91 | 22 | 4 |
| shared | 4 | 242 | 23 | 0 |
| vehicle | 54 | 1,360 | 1,328 | 0 |
| wheel | 3 | 98 | 29 | 0 |
| **total** | **193** | **2,732** | **1,558** | **19** |

### 3.2 Codec, rate and channel coverage

| Codec | Waves | Decode status |
| --- | ---: | --- |
| `uADPCM4Bit` (format 7) | 2,728 | decoded where in a non-streaming bank; the decode is the retail block decoder |
| `PCM16` (format 3) | 4 | **not implemented**; all four are in streaming banks and are `unsupported/streaming-container` |

| Sample rate | Waves | Notes |
| --- | ---: | --- |
| 48 kHz | 2,052 | all UI, wheel, pickups, music, environment and non-AI vehicle banks |
| 36 kHz | 680 | the `*_AI` vehicle banks (27 banks) |

Channels: **mono 1,899**, **stereo 833**.
All decoded event waves are 48 kHz; stereo waves are interleaved 33-byte
left/right blocks per 64-sample frame, exactly as `ReadVagStreamStereo`.

### 3.3 Streaming banks

These banks have `BankHeader.streaming = 1` and no inline `DATA` chunks; their
waves are `unsupported/streaming-container` in this slice.

| Bank | Waves | Bytes |
| --- | ---: | ---: |
| `\env_amboy_st.baf` | 4 | 10,221,568 |
| `\env_battle.baf` | 40 | 36,982,784 |
| `\env_brighton_st.baf` | 2 | 1,984,512 |
| `\env_fireworks.baf` | 3 | 5,603,328 |
| `\env_gracia_st.baf` | 4 | 8,878,080 |
| `\env_hackney_st.baf` | 4 | 10,905,600 |
| `\env_hollywood_hills_st.baf` | 4 | 10,905,600 |
| `\env_ladocks_st.baf` | 4 | 8,857,600 |
| `\env_la_downtown_st.baf` | 4 | 10,905,600 |
| `\env_mt_haruna_st.baf` | 4 | 10,905,600 |
| `\env_ny_dumbo_st.baf` | 4 | 10,905,600 |
| `\env_oval_st.baf` | 4 | 8,878,080 |
| `\env_sf_hill_st.baf` | 4 | 10,905,600 |
| `\env_sf_sausalito_st.baf` | 4 | 10,905,600 |
| `\env_shutoko_st.baf` | 4 | 10,696,704 |
| `\ingamecustommusic.baf` | 22 | 18,644,992 |
| `\ingamemusic.baf` | 24 | 328,650,752 |
| `\menumusic.baf` | 8 | 24,064,000 |
| `\vistamusic.baf` | 18 | 13,275,136 |

### 3.4 Full bank table

| Asset | Bank | Pak | Waves | Loops | Rates | Ch | Stream | SHA-256 (first 16) |
| --- | --- | --- | ---: | ---: | --- | --- | :---: | --- |
| `\audio\audi_i4.baf` | `Audi_i4` | `root.pak` | 25 | 24 | 48000 | 1,2 | no | `9b294491dc3e7e08` |
| `\audio\audi_i4_ai.baf` | `Audi_i4_AI` | `root.pak` | 25 | 24 | 36000 | 1,2 | no | `9b74acff0cc9ea49` |
| `\audio\bmw_i6.baf` | `BMW_i6` | `root.pak` | 23 | 22 | 48000 | 1,2 | no | `5f6749084a418b05` |
| `\audio\bmw_i6_ai.baf` | `BMW_i6_AI` | `root.pak` | 23 | 22 | 36000 | 1,2 | no | `e7ab5fbdbb1e6119` |
| `\audio\bmw_v8.baf` | `BMW_V8` | `root.pak` | 28 | 28 | 48000 | 1,2 | no | `2b84b9c80e9b2539` |
| `\audio\bmw_v8_ai.baf` | `BMW_V8_AI` | `root.pak` | 28 | 28 | 36000 | 1,2 | no | `ed6a6677651129f2` |
| `\audio\bossmusic_ns.baf` | `BossMusic_NS` | `root.pak` | 4 | 0 | 48000 | 2 | no | `4621365a5ffd9ed7` |
| `\audio\car_collisions.baf` | `Car_Collisions` | `root.pak` | 124 | 3 | 48000 | 1,2 | no | `9663d8210f5d21dc` |
| `\audio\car_common.baf` | `Car_Common` | `root.pak` | 24 | 5 | 48000 | 1,2 | no | `955adaffd18c5c80` |
| `\audio\ccxr_v8.baf` | `CCXR_V8` | `root.pak` | 28 | 28 | 48000 | 1,2 | no | `5a5285ccfca85b09` |
| `\audio\ccxr_v8_ai.baf` | `CCXR_V8_AI` | `root.pak` | 28 | 28 | 36000 | 1,2 | no | `b6e743aa13dd64f3` |
| `\audio\checkpointmusic_ns.baf` | `CheckpointMusic_NS` | `root.pak` | 6 | 0 | 48000 | 2 | no | `f2c9bffa8c3fa502` |
| `\audio\chevy_v8.baf` | `Chevy_V8` | `root.pak` | 27 | 27 | 48000 | 1,2 | no | `016ae0c60cb849b7` |
| `\audio\chevy_v8_ai.baf` | `Chevy_V8_AI` | `root.pak` | 27 | 27 | 36000 | 1,2 | no | `33aa3e3c9a37aea9` |
| `\audio\chevy_v8_bigblock.baf` | `Chevy_V8_bigblock` | `root.pak` | 25 | 25 | 48000 | 1,2 | no | `ba67c03771c89034` |
| `\audio\chevy_v8_bigblock_ai.baf` | `Chevy_V8_bigblock_AI` | `root.pak` | 25 | 25 | 36000 | 1,2 | no | `cf543db3840fd0f0` |
| `\audio\destructionmusic_ns.baf` | `DestructionMusic_NS` | `root.pak` | 5 | 0 | 48000 | 2 | no | `7e33e02c41be9d91` |
| `\audio\do_brk_metal.baf` | `DO_brk_metal` | `root.pak` | 3 | 0 | 48000 | 1 | no | `76c4919f88bb87a5` |
| `\audio\do_brk_metal_building.baf` | `DO_brk_metal_building` | `root.pak` | 3 | 0 | 48000 | 1 | no | `cbc7f44d02fa63b0` |
| `\audio\do_brk_metal_structure.baf` | `DO_brk_metal_structure` | `root.pak` | 3 | 0 | 48000 | 1 | no | `0e534f366e21f649` |
| `\audio\do_brk_paper_debris.baf` | `DO_brk_paper_debris` | `root.pak` | 3 | 0 | 48000 | 1 | no | `1a2499e0cc4df78d` |
| `\audio\do_brk_plastic.baf` | `DO_brk_plastic` | `root.pak` | 3 | 0 | 48000 | 1 | no | `1c05d0063c227da1` |
| `\audio\do_brk_plastic_water_barrel.baf` | `DO_brk_plastic_water_barrel` | `root.pak` | 3 | 0 | 48000 | 1 | no | `44ed9515b9605948` |
| `\audio\do_brk_rubbish.baf` | `DO_brk_rubbish` | `root.pak` | 2 | 0 | 48000 | 1 | no | `fe3fa112ca3e82c7` |
| `\audio\do_brk_water_spray.baf` | `DO_brk_water_spray` | `root.pak` | 1 | 1 | 48000 | 1 | no | `73033d39d3304ef9` |
| `\audio\do_brk_wood.baf` | `DO_brk_wood` | `root.pak` | 3 | 0 | 48000 | 1 | no | `135f75e4c74c92d5` |
| `\audio\do_brk_wood_door.baf` | `DO_brk_wood_door` | `root.pak` | 3 | 0 | 48000 | 1 | no | `0ffad8cbc50d78fb` |
| `\audio\do_cardboard_box.baf` | `DO_cardboard_box` | `root.pak` | 3 | 0 | 48000 | 1 | no | `20c0bf6a4f84b264` |
| `\audio\do_concrete_fence_chain.baf` | `DO_concrete_fence_chain` | `root.pak` | 3 | 0 | 48000 | 1 | no | `d4ea14dddcd9b2ac` |
| `\audio\do_concrete_fence_plastic.baf` | `DO_concrete_fence_plastic` | `root.pak` | 3 | 0 | 48000 | 1 | no | `5a2071bac0b8ef02` |
| `\audio\do_concrete_large.baf` | `DO_concrete_large` | `root.pak` | 3 | 0 | 48000 | 1 | no | `d8996c4e235ab184` |
| `\audio\do_glass_hit.baf` | `DO_glass_hit` | `root.pak` | 3 | 0 | 48000 | 1 | no | `d5f7db3bde85e7f6` |
| `\audio\do_glass_shatter.baf` | `DO_glass_shatter` | `root.pak` | 3 | 0 | 48000 | 1 | no | `1fce6f302820aaa4` |
| `\audio\do_metal_alloyrim.baf` | `DO_metal_alloyrim` | `root.pak` | 3 | 0 | 48000 | 1 | no | `bd8f97c3301b0128` |
| `\audio\do_metal_armco.baf` | `DO_metal_armco` | `root.pak` | 5 | 0 | 48000 | 1 | no | `90d2d41817c36203` |
| `\audio\do_metal_fence_chainlink.baf` | `DO_metal_fence_chainlink` | `root.pak` | 3 | 0 | 48000 | 1 | no | `af1bf9599e539103` |
| `\audio\do_metal_hollow_large.baf` | `DO_metal_hollow_large` | `root.pak` | 3 | 0 | 48000 | 1 | no | `bebc859ad1306bb3` |
| `\audio\do_metal_hollow_small.baf` | `DO_metal_hollow_small` | `root.pak` | 3 | 0 | 48000 | 1 | no | `23407110d541b32b` |
| `\audio\do_metal_pipe_thin.baf` | `DO_metal_pipe_thin` | `root.pak` | 3 | 0 | 48000 | 1 | no | `e70eedc3f7bc68ed` |
| `\audio\do_metal_post_medium.baf` | `DO_metal_post_medium` | `root.pak` | 3 | 0 | 48000 | 1 | no | `282e91bce179a312` |
| `\audio\do_metal_post_short.baf` | `DO_metal_post_short` | `root.pak` | 3 | 0 | 48000 | 1 | no | `f558c109f3e5e8ff` |
| `\audio\do_metal_post_tall.baf` | `DO_metal_post_tall` | `root.pak` | 3 | 0 | 48000 | 1 | no | `6bb8ab420765864d` |
| `\audio\do_metal_railing.baf` | `DO_metal_railing` | `root.pak` | 3 | 0 | 48000 | 1 | no | `0c0b52f11d3234ca` |
| `\audio\do_metal_scaffold.baf` | `DO_metal_scaffold` | `root.pak` | 3 | 0 | 48000 | 1 | no | `263a8c4d8d71ec50` |
| `\audio\do_metal_sheet.baf` | `DO_metal_sheet` | `root.pak` | 3 | 0 | 48000 | 1 | no | `022945df9a218088` |
| `\audio\do_metal_sheet_large.baf` | `DO_metal_sheet_large` | `root.pak` | 3 | 0 | 48000 | 1 | no | `0c572d27bdad26bc` |
| `\audio\do_metal_sign_chevron.baf` | `DO_metal_sign_chevron` | `root.pak` | 3 | 0 | 48000 | 1 | no | `937c7e072659f59a` |
| `\audio\do_metal_solid_large.baf` | `DO_metal_solid_large` | `root.pak` | 3 | 0 | 48000 | 1 | no | `4d2906ff3265dfd1` |
| `\audio\do_metal_solid_medium.baf` | `DO_metal_solid_medium` | `root.pak` | 3 | 0 | 48000 | 1 | no | `c3428472206690f0` |
| `\audio\do_metal_solid_small.baf` | `DO_metal_solid_small` | `root.pak` | 3 | 0 | 48000 | 1 | no | `3091eb63bd857795` |
| `\audio\do_metal_trolley.baf` | `DO_metal_trolley` | `root.pak` | 3 | 0 | 48000 | 1 | no | `69159d53576b5fdf` |
| `\audio\do_metal_vehicle_bus.baf` | `DO_metal_vehicle_bus` | `root.pak` | 3 | 0 | 48000 | 1 | no | `f13bfc681b642d43` |
| `\audio\do_metal_vehicle_car.baf` | `DO_metal_vehicle_car` | `root.pak` | 3 | 0 | 48000 | 1 | no | `f140a57f53ede177` |
| `\audio\do_metal_vehicle_motorbike.baf` | `DO_metal_vehicle_motorbike` | `root.pak` | 3 | 0 | 48000 | 1 | no | `f8bcc9a9461640d1` |
| `\audio\do_plastic_binbag.baf` | `DO_plastic_binbag` | `root.pak` | 3 | 0 | 48000 | 1 | no | `379f938adb1aa002` |
| `\audio\do_plastic_cone.baf` | `DO_plastic_cone` | `root.pak` | 3 | 0 | 48000 | 1 | no | `54dcdbc85ebe98c7` |
| `\audio\do_plastic_furniture.baf` | `DO_plastic_furniture` | `root.pak` | 3 | 0 | 48000 | 1 | no | `b56931b7bb6295f0` |
| `\audio\do_plastic_post.baf` | `DO_plastic_post` | `root.pak` | 3 | 0 | 48000 | 1 | no | `7715fd3abc0128e8` |
| `\audio\do_plastic_sign.baf` | `DO_plastic_sign` | `root.pak` | 3 | 0 | 48000 | 1 | no | `df90e72fd3b95f9a` |
| `\audio\do_plastic_water_barrel.baf` | `DO_plastic_water_barrel` | `root.pak` | 3 | 0 | 48000 | 1 | no | `7f053dc2465626a9` |
| `\audio\do_plastic_wheelbin.baf` | `DO_plastic_wheelbin` | `root.pak` | 3 | 0 | 48000 | 1 | no | `9feea7bffcab40ac` |
| `\audio\do_rubber_tyre.baf` | `DO_rubber_tyre` | `root.pak` | 3 | 0 | 48000 | 1 | no | `caf4e6238277ddd7` |
| `\audio\do_vegetation_hedge.baf` | `DO_vegetation_hedge` | `root.pak` | 3 | 0 | 48000 | 1 | no | `e98bf8389b31c993` |
| `\audio\do_vehicle_alarm.baf` | `DO_vehicle_alarm` | `root.pak` | 3 | 3 | 48000 | 1 | no | `d285b80a8fce51d3` |
| `\audio\do_wood_door.baf` | `DO_wood_door` | `root.pak` | 3 | 0 | 48000 | 1 | no | `5c053d256acd0fc8` |
| `\audio\do_wood_fence.baf` | `DO_wood_fence` | `root.pak` | 3 | 0 | 48000 | 1 | no | `ed505608e5fb359e` |
| `\audio\do_wood_tree.baf` | `DO_wood_tree` | `root.pak` | 3 | 0 | 48000 | 1 | no | `8ee140a24381eb69` |
| `\audio\dodge_v10.baf` | `Dodge_V10` | `root.pak` | 25 | 24 | 48000 | 1,2 | no | `45fc6a2536355c16` |
| `\audio\dodge_v10_ai.baf` | `Dodge_V10_AI` | `root.pak` | 25 | 24 | 36000 | 1,2 | no | `05ac3d86528bd142` |
| `\audio\dodge_v8.baf` | `Dodge_V8` | `root.pak` | 25 | 25 | 48000 | 1,2 | no | `1f7c2c145d05dda3` |
| `\audio\dodge_v8_ai.baf` | `Dodge_V8_AI` | `root.pak` | 25 | 25 | 36000 | 1,2 | no | `fafd38d987ba8fc0` |
| `\audio\f1_v8.baf` | `F1_V8` | `root.pak` | 29 | 29 | 48000 | 1,2 | no | `f7526e9c6bba78a4` |
| `\audio\f1_v8_ai.baf` | `F1_V8_AI` | `root.pak` | 29 | 29 | 36000 | 1,2 | no | `95da5378a117e21d` |
| `\audio\ford_i5.baf` | `Ford_i5` | `root.pak` | 25 | 23 | 48000 | 1,2 | no | `c0f6658e9ec3f54f` |
| `\audio\ford_i5_ai.baf` | `Ford_i5_AI` | `root.pak` | 25 | 23 | 36000 | 1,2 | no | `3eafa63b2af76f72` |
| `\audio\ford_v8.baf` | `Ford_V8` | `root.pak` | 26 | 26 | 48000 | 1,2 | no | `cd1c91e6979dc187` |
| `\audio\ford_v8_ai.baf` | `Ford_V8_AI` | `root.pak` | 26 | 26 | 36000 | 1,2 | no | `8133a05615df2504` |
| `\audio\ford_v8_bigblock.baf` | `Ford_V8_bigblock` | `root.pak` | 25 | 25 | 48000 | 1,2 | no | `2a7ed033ddba58f2` |
| `\audio\ford_v8_bigblock_ai.baf` | `Ford_V8_bigblock_AI` | `root.pak` | 25 | 25 | 36000 | 1,2 | no | `da14231d90c91383` |
| `\audio\ford_v8_cammer.baf` | `Ford_V8_Cammer` | `root.pak` | 26 | 26 | 48000 | 1,2 | no | `e0e45f7ab857037e` |
| `\audio\ford_v8_cammer_ai.baf` | `Ford_V8_Cammer_AI` | `root.pak` | 26 | 26 | 36000 | 1,2 | no | `12598715c743ba68` |
| `\audio\frontendui.baf` | `FrontEndUI` | `root.pak` | 58 | 0 | 48000 | 1,2 | no | `a7c2aea7826f6942` |
| `\audio\garageui.baf` | `GarageUI` | `root.pak` | 108 | 54 | 48000 | 1,2 | no | `e29b361cfe8da97f` |
| `\audio\gm_v8.baf` | `GM_V8` | `root.pak` | 27 | 27 | 48000 | 1,2 | no | `a4ecdcdd86d4cb2e` |
| `\audio\gm_v8_ai.baf` | `GM_V8_AI` | `root.pak` | 27 | 27 | 36000 | 1,2 | no | `0483c048204d82ed` |
| `\audio\ingameui.baf` | `InGameUI` | `root.pak` | 95 | 0 | 48000 | 1,2 | no | `3f02e799ff3bb925` |
| `\audio\lotus_i4.baf` | `Lotus_i4` | `root.pak` | 25 | 25 | 48000 | 1,2 | no | `b788598d96949f31` |
| `\audio\lotus_i4_ai.baf` | `Lotus_i4_AI` | `root.pak` | 25 | 25 | 36000 | 1,2 | no | `443e4c4550b93dcc` |
| `\audio\lr_v8.baf` | `LR_V8` | `root.pak` | 19 | 18 | 48000 | 1,2 | no | `0181c788fcfe7e0f` |
| `\audio\lr_v8_ai.baf` | `LR_V8_AI` | `root.pak` | 19 | 18 | 36000 | 1,2 | no | `306cf194f8d9b1e5` |
| `\audio\menumusic_ns.baf` | `MenuMusic_NS` | `root.pak` | 4 | 1 | 48000 | 2 | no | `587574b56ca45724` |
| `\audio\nissan_i6.baf` | `Nissan_i6` | `root.pak` | 24 | 23 | 48000 | 1,2 | no | `45fc1431172660ca` |
| `\audio\nissan_i6_ai.baf` | `Nissan_i6_AI` | `root.pak` | 24 | 23 | 36000 | 1,2 | no | `1ef52d7e81651bef` |
| `\audio\nissan_v6.baf` | `Nissan_V6` | `root.pak` | 24 | 23 | 48000 | 1,2 | no | `ddd5203066c939d1` |
| `\audio\nissan_v6_ai.baf` | `Nissan_V6_AI` | `root.pak` | 24 | 23 | 36000 | 1,2 | no | `01d21d45c6fc04c2` |
| `\audio\nissan_v6_pickup.baf` | `Nissan_V6_Pickup` | `root.pak` | 22 | 21 | 48000 | 1,2 | no | `0eee45daa6dc0f07` |
| `\audio\nissan_v6_pickup_ai.baf` | `Nissan_V6_Pickup_AI` | `root.pak` | 22 | 21 | 36000 | 1,2 | no | `984857c8954a3735` |
| `\audio\pickups.baf` | `Pickups` | `root.pak` | 68 | 14 | 48000 | 1 | no | `28e9fe22bb739959` |
| `\audio\proximity.baf` | `Proximity` | `root.pak` | 26 | 1 | 48000 | 1,2 | no | `8dd872d531b05e6e` |
| `\audio\race_flat4.baf` | `Race_flat4` | `root.pak` | 25 | 25 | 48000 | 1,2 | no | `f6c6129d01d2118e` |
| `\audio\race_flat4_ai.baf` | `Race_flat4_AI` | `root.pak` | 25 | 25 | 36000 | 1,2 | no | `216357201bb85d3a` |
| `\audio\race_i4.baf` | `Race_i4` | `root.pak` | 27 | 25 | 48000 | 1,2 | no | `c7703a4dd679e9d2` |
| `\audio\race_i4_ai.baf` | `Race_i4_AI` | `root.pak` | 27 | 25 | 36000 | 1,2 | no | `0baa3a4ed89ea00b` |
| `\audio\race_v6.baf` | `Race_V6` | `root.pak` | 24 | 23 | 48000 | 1,2 | no | `753cd7b7ff910740` |
| `\audio\race_v6_ai.baf` | `Race_V6_AI` | `root.pak` | 24 | 23 | 36000 | 1,2 | no | `951627a83443c82e` |
| `\audio\race_v8.baf` | `Race_V8` | `root.pak` | 26 | 26 | 48000 | 1,2 | no | `f9d25fd4762d1fcf` |
| `\audio\race_v8_ai.baf` | `Race_V8_AI` | `root.pak` | 26 | 26 | 36000 | 1,2 | no | `cf08299f72127d6f` |
| `\audio\renault_i4.baf` | `Renault_i4` | `root.pak` | 24 | 23 | 48000 | 1,2 | no | `6e6393488730ac35` |
| `\audio\renault_i4_ai.baf` | `Renault_i4_AI` | `root.pak` | 24 | 23 | 36000 | 1,2 | no | `7cef9a67ec46983a` |
| `\audio\toyota_i6.baf` | `Toyota_i6` | `root.pak` | 26 | 24 | 48000 | 1,2 | no | `0094c06ada8998fd` |
| `\audio\toyota_i6_ai.baf` | `Toyota_i6_AI` | `root.pak` | 26 | 24 | 36000 | 1,2 | no | `7b2f3f335e7932da` |
| `\audio\voiceoverui_de.baf` | `VoiceOverUI_de` | `root.pak` | 42 | 0 | 48000 | 1 | no | `b30f5620f2262757` |
| `\audio\voiceoverui_en.baf` | `VoiceOverUI_en` | `root.pak` | 44 | 0 | 48000 | 1 | no | `0106dfdf179b823c` |
| `\audio\voiceoverui_es.baf` | `VoiceOverUI_es` | `root.pak` | 42 | 0 | 48000 | 1 | no | `f129705188a75d07` |
| `\audio\voiceoverui_fr.baf` | `VoiceOverUI_fr` | `root.pak` | 42 | 0 | 48000 | 1 | no | `0f79c3b35a6c8cf0` |
| `\audio\voiceoverui_it.baf` | `VoiceOverUI_it` | `root.pak` | 42 | 0 | 48000 | 1 | no | `c6b89c545d3ca01c` |
| `\audio\voiceoverui_ja.baf` | `VoiceOverUI_ja` | `root.pak` | 42 | 0 | 48000 | 1 | no | `af2c2d87c42e2213` |
| `\audio\voiceoverui_pl.baf` | `VoiceOverUI_pl` | `root.pak` | 42 | 0 | 48000 | 1 | no | `49b21f652c89ba50` |
| `\audio\voiceoverui_ru.baf` | `VoiceOverUI_ru` | `root.pak` | 42 | 0 | 48000 | 1 | no | `62341af588c211aa` |
| `\audio\vw_flat4.baf` | `VW_flat4` | `root.pak` | 26 | 26 | 48000 | 1,2 | no | `16da5e574e6f830f` |
| `\audio\vw_flat4_ai.baf` | `VW_flat4_AI` | `root.pak` | 26 | 26 | 36000 | 1,2 | no | `3f0f272af6591f49` |
| `\audio\vw_w12.baf` | `VW_W12` | `root.pak` | 24 | 23 | 48000 | 1,2 | no | `8189b903eebed558` |
| `\audio\vw_w12_ai.baf` | `VW_W12_AI` | `root.pak` | 24 | 23 | 36000 | 1,2 | no | `093b4081dca6ecb1` |
| `\audio\wheel_common.baf` | `Wheel_common` | `root.pak` | 37 | 5 | 48000 | 1 | no | `2643e11085003d4e` |
| `\audio\wheel_dry.baf` | `Wheel_dry` | `root.pak` | 11 | 11 | 48000 | 1 | no | `8d451333a1392360` |
| `\audio\wheel_offroad.baf` | `Wheel_offroad` | `root.pak` | 50 | 13 | 48000 | 1 | no | `cb0dfc118957d70a` |
| `\env_amboy_mem.baf` | `ENV_Amboy_Mem` | `root_streaming.pak` | 2 | 2 | 48000 | 2 | no | `e295cc104560ea39` |
| `\env_amboy_st.baf` | `ENV_Amboy_ST` | `root_streaming.pak` | 4 | 2 | 48000 | 2 | yes | `fa1737a4ddd116a3` |
| `\env_battle.baf` | `ENV_Battle` | `root_streaming.pak` | 40 | 0 | 48000 | 2 | yes | `52e6d31300a0588f` |
| `\env_birds_takeoff.baf` | `ENV_Birds_takeoff` | `root_streaming.pak` | 1 | 0 | 48000 | 1 | no | `5efb10275bd576b5` |
| `\env_boathorn.baf` | `ENV_boathorn` | `root_streaming.pak` | 1 | 0 | 48000 | 1 | no | `65bb8b6f1751a715` |
| `\env_brighton_mem.baf` | `ENV_Brighton_Mem` | `root_streaming.pak` | 2 | 2 | 48000 | 2 | no | `41b0697b20359dfa` |
| `\env_brighton_st.baf` | `ENV_Brighton_ST` | `root_streaming.pak` | 2 | 0 | 48000 | 2 | yes | `7f5945a952a48402` |
| `\env_cafe_sign.baf` | `ENV_cafe_sign` | `root_streaming.pak` | 1 | 1 | 48000 | 1 | no | `f14d8328245efa52` |
| `\env_church_bell.baf` | `ENV_church_bell` | `root_streaming.pak` | 1 | 0 | 48000 | 1 | no | `3893d567b54ff709` |
| `\env_cicadas.baf` | `ENV_cicadas` | `root_streaming.pak` | 1 | 1 | 48000 | 1 | no | `a2e307b1e9709ab7` |
| `\env_crowd_large.baf` | `ENV_crowd_large` | `root_streaming.pak` | 2 | 2 | 48000 | 1 | no | `1967e7ceb1f69293` |
| `\env_crowd_medium.baf` | `ENV_crowd_medium` | `root_streaming.pak` | 3 | 3 | 48000 | 1 | no | `8ea7afba27a85190` |
| `\env_crowd_party.baf` | `ENV_crowd_party` | `root_streaming.pak` | 6 | 6 | 48000 | 1 | no | `ee317f08dcde0acc` |
| `\env_crowd_small.baf` | `ENV_crowd_small` | `root_streaming.pak` | 3 | 3 | 48000 | 1 | no | `39a18224d877842b` |
| `\env_docks_crane.baf` | `ENV_docks_crane` | `root_streaming.pak` | 6 | 1 | 48000 | 1 | no | `529951c6b3846c8b` |
| `\env_docks_loading.baf` | `ENV_docks_loading` | `root_streaming.pak` | 1 | 1 | 48000 | 1 | no | `2e70408bfe6dd35e` |
| `\env_docks_siren.baf` | `ENV_docks_siren` | `root_streaming.pak` | 1 | 1 | 48000 | 1 | no | `466f2b6d721cd3e1` |
| `\env_docks_trucks.baf` | `ENV_docks_trucks` | `root_streaming.pak` | 1 | 1 | 48000 | 1 | no | `6023255ca49333cf` |
| `\env_electricity_arcs.baf` | `ENV_Electricity_arcs` | `root_streaming.pak` | 1 | 1 | 48000 | 1 | no | `189d4df1cc12848a` |
| `\env_fireworks.baf` | `ENV_Fireworks` | `root_streaming.pak` | 3 | 3 | 48000 | 1,2 | yes | `272295afc5ec83ba` |
| `\env_fireworks_mem.baf` | `ENV_Fireworks_MEM` | `root_streaming.pak` | 9 | 0 | 48000 | 1,2 | no | `d7f97c559d469a3a` |
| `\env_flare.baf` | `ENV_flare` | `root_streaming.pak` | 1 | 1 | 48000 | 1 | no | `bbfc9339bfb3d55c` |
| `\env_floodgate.baf` | `ENV_floodgate` | `root_streaming.pak` | 1 | 1 | 48000 | 1 | no | `e32d528d0933f0cd` |
| `\env_funfair.baf` | `ENV_funfair` | `root_streaming.pak` | 5 | 1 | 48000 | 1 | no | `d71a447ae6761769` |
| `\env_gracia_mem.baf` | `ENV_Gracia_Mem` | `root_streaming.pak` | 2 | 2 | 48000 | 2 | no | `e9f97fd6939a0264` |
| `\env_gracia_st.baf` | `ENV_Gracia_ST` | `root_streaming.pak` | 4 | 2 | 48000 | 2 | yes | `2fad49d7bb912955` |
| `\env_hackney_mem.baf` | `ENV_Hackney_Mem` | `root_streaming.pak` | 2 | 2 | 48000 | 2 | no | `3962a7db946130bf` |
| `\env_hackney_st.baf` | `ENV_Hackney_ST` | `root_streaming.pak` | 4 | 2 | 48000 | 2 | yes | `6d093f0e7d0a1e4d` |
| `\env_helicopter.baf` | `ENV_Helicopter` | `root_streaming.pak` | 1 | 1 | 48000 | 1 | no | `2853c9dac223b7fc` |
| `\env_hollywood_hills_mem.baf` | `ENV_Hollywood_Hills_Mem` | `root_streaming.pak` | 2 | 2 | 48000 | 2 | no | `68e969995b602dd3` |
| `\env_hollywood_hills_st.baf` | `ENV_Hollywood_Hills_ST` | `root_streaming.pak` | 4 | 2 | 48000 | 2 | yes | `8d1ed45b188db6a5` |
| `\env_la_downtown_mem.baf` | `ENV_LA_Downtown_MEM` | `root_streaming.pak` | 2 | 2 | 48000 | 2 | no | `f1bd4e7ba364026b` |
| `\env_la_downtown_st.baf` | `ENV_LA_Downtown_ST` | `root_streaming.pak` | 4 | 2 | 48000 | 2 | yes | `2b33ab0daeeb095b` |
| `\env_ladocks_mem.baf` | `ENV_LADocks_Mem` | `root_streaming.pak` | 2 | 2 | 48000 | 2 | no | `14c59983f2c1fd64` |
| `\env_ladocks_st.baf` | `ENV_LADocks_ST` | `root_streaming.pak` | 4 | 2 | 48000 | 2 | yes | `49a8c4850884b2ae` |
| `\env_lariver_mem.baf` | `ENV_LARiver_Mem` | `root_streaming.pak` | 2 | 2 | 48000 | 2 | no | `ccfb3b4a439281fe` |
| `\env_lariver_st.baf` | `ENV_LARiver_ST` | `root_streaming.pak` | 4 | 2 | 48000 | 2 | no | `073d08cbff443d5a` |
| `\env_level_crossing.baf` | `ENV_level_crossing` | `root_streaming.pak` | 1 | 1 | 48000 | 1 | no | `ccf55c6488636e4e` |
| `\env_mt_haruna_mem.baf` | `ENV_Mt_Haruna_Mem` | `root_streaming.pak` | 2 | 2 | 48000 | 2 | no | `718779801900b894` |
| `\env_mt_haruna_st.baf` | `ENV_Mt_Haruna_ST` | `root_streaming.pak` | 4 | 2 | 48000 | 2 | yes | `ab000630e091904b` |
| `\env_neon.baf` | `ENV_neon` | `root_streaming.pak` | 1 | 1 | 48000 | 1 | no | `82061f1689217fd9` |
| `\env_ny_dumbo_mem.baf` | `ENV_NY_Dumbo_Mem` | `root_streaming.pak` | 2 | 2 | 48000 | 2 | no | `ef9f60819541a9ba` |
| `\env_ny_dumbo_st.baf` | `ENV_NY_Dumbo_ST` | `root_streaming.pak` | 4 | 2 | 48000 | 2 | yes | `e8e714439a84f48a` |
| `\env_oil_derrick.baf` | `ENV_Oil_Derrick` | `root_streaming.pak` | 1 | 1 | 48000 | 1 | no | `066f3674467edb6d` |
| `\env_oil_flames.baf` | `ENV_Oil_flames` | `root_streaming.pak` | 1 | 1 | 48000 | 1 | no | `407e9334baf09ebc` |
| `\env_oval_mem.baf` | `ENV_Oval_Mem` | `root_streaming.pak` | 2 | 2 | 48000 | 2 | no | `274bdc7a9a0dfa17` |
| `\env_oval_st.baf` | `ENV_Oval_ST` | `root_streaming.pak` | 4 | 2 | 48000 | 2 | yes | `f92325402e659b39` |
| `\env_sea_shoreline.baf` | `ENV_Sea_Shoreline` | `root_streaming.pak` | 1 | 1 | 48000 | 1 | no | `e4dae476bd9e02e0` |
| `\env_sf_hill_mem.baf` | `ENV_SF_Hill_Mem` | `root_streaming.pak` | 2 | 2 | 48000 | 2 | no | `5b425376f4351906` |
| `\env_sf_hill_st.baf` | `ENV_SF_Hill_ST` | `root_streaming.pak` | 4 | 2 | 48000 | 2 | yes | `95b9f76ef0d8626c` |
| `\env_sf_sausalito_mem.baf` | `ENV_SF_Sausalito_Mem` | `root_streaming.pak` | 2 | 2 | 48000 | 2 | no | `413d83043b98c02d` |
| `\env_sf_sausalito_st.baf` | `ENV_SF_Sausalito_ST` | `root_streaming.pak` | 4 | 2 | 48000 | 2 | yes | `a22f61744e3b0825` |
| `\env_shutoko_mem.baf` | `ENV_Shutoko_Mem` | `root_streaming.pak` | 2 | 2 | 48000 | 2 | no | `c0275020b7d4e14b` |
| `\env_shutoko_st.baf` | `ENV_Shutoko_ST` | `root_streaming.pak` | 4 | 2 | 48000 | 2 | yes | `e52be46f54f70bb7` |
| `\env_siren.baf` | `ENV_Siren` | `root_streaming.pak` | 3 | 3 | 48000 | 1 | no | `4167539137bb9524` |
| `\env_sparks.baf` | `ENV_sparks` | `root_streaming.pak` | 6 | 0 | 48000 | 1 | no | `7d598a3ac802e893` |
| `\env_traffic.baf` | `ENV_Traffic` | `root_streaming.pak` | 2 | 2 | 48000 | 1 | no | `b4d08a669a9498e4` |
| `\env_train_subway.baf` | `ENV_train_subway` | `root_streaming.pak` | 1 | 1 | 48000 | 1 | no | `c6d1e86360ec40bb` |
| `\env_vehicle_car.baf` | `ENV_vehicle_car` | `root_streaming.pak` | 1 | 1 | 48000 | 1 | no | `3e10c37236fa7240` |
| `\env_vehicle_lorry.baf` | `ENV_vehicle_lorry` | `root_streaming.pak` | 1 | 1 | 48000 | 1 | no | `16cee42a4aa5a1ef` |
| `\env_vehicle_plane_prop.baf` | `ENV_vehicle_plane_prop` | `root_streaming.pak` | 1 | 1 | 48000 | 1 | no | `2585738d3414caed` |
| `\env_vehicle_train.baf` | `ENV_vehicle_train` | `root_streaming.pak` | 1 | 1 | 48000 | 1 | no | `b957cce110910bff` |
| `\env_vehicle_tram.baf` | `ENV_vehicle_tram` | `root_streaming.pak` | 1 | 1 | 48000 | 1 | no | `5de041f78154c949` |
| `\ingamecustommusic.baf` | `InGameCustomMusic` | `root_streaming.pak` | 22 | 13 | 48000 | 2 | yes | `6bdb1cb59c6ef604` |
| `\ingamemusic.baf` | `InGameMusic` | `root_streaming.pak` | 24 | 0 | 48000 | 2 | yes | `header-only` |
| `\menumusic.baf` | `MenuMusic` | `root_streaming.pak` | 8 | 8 | 48000 | 2 | yes | `8868d02b0bd918c9` |
| `\vistamusic.baf` | `VistaMusic` | `root_streaming.pak` | 18 | 0 | 48000 | 2 | yes | `34462d0aca9852ef` |

The full per-wave table (name, index, format, codec, rate, channels, samples,
loop flag, `dataStart`, `dataLength`) is in `_work/audio/audio-catalog.json`
under `banks`.

## 4. Entities and graphs

| Group | Entities |
| --- | ---: |
| Collision | 6 |
| Default | 49 |
| DynamicObjects | 75 |
| Listener | 1 |
| Music | 4 |
| Perks | 18 |
| System | 1 |
| UI | 2 |
| Vehicle | 70 |
| Wheels | 2 |
| **total** | **228** |

`audio.bin` holds 367 `AudioObject` filenames; an `AudioEntityDef` instantiates
one or more of them. The 365 shipped `.dat` graphs parse without a walk error
in this catalog (2,601 sound components). The earlier
race-engine component-count anomaly is resolved by the parser's per-component
size table; no component is guessed.

The event map uses the retail entity name and the retail graph component name as
the trigger basis. No trigger is invented: every `decoded`/`decodable` row names
the exact `AudioEntityDef` and `.dat` component that owns the sound.

## 5. Event -> wave table

### 5.1 Coverage by category

| Category | Events | decoded | decodable | unsupported |
| --- | ---: | ---: | ---: | ---: |
| ambience | 38 | 0 | 38 | 0 |
| collision | 14 | 14 | 0 | 0 |
| engine | 19 | 6 | 13 | 0 |
| music | 89 | 0 | 19 | 70 |
| powerup | 47 | 47 | 0 | 0 |
| race | 71 | 71 | 0 | 0 |
| tyre | 12 | 12 | 0 | 0 |
| ui | 44 | 44 | 0 | 0 |
| **total** | **334** | **194** | **70** | **70** |

A wave is one row per variant. Multi-wave events list every variant separated
by `<br>`. `@0x...` is the wave's `dataStart` inside the decoded bank.

### 5.2 ui (44 events)

| Event | Entity / graph | Component | Wave / provenance |
| --- | --- | --- | --- |
| `ui.apply_bossmod` | `FrontEndUI` / `FrontEndUI.dat` | `FE_ApplyBossModSound` | `FrontEndUI#44:FE_ApplyBossMod`<br>@0x1a4803 · uADPCM4Bit 48000/2ch · 1.031688s · one-shot · **decoded** |
| `ui.boss_demand.complete` | `FrontEndUI` / `FrontEndUI.dat` | `FE_BossDemandCompleteSound` | `FrontEndUI#45:FE_BossDemandComplete`<br>@0x1b0f97 · uADPCM4Bit 48000/2ch · 1.384062s · one-shot · **decoded** |
| `ui.boss_demand.increment` | `FrontEndUI` / `FrontEndUI.dat` | `FE_BossDemandIncrementSound` | `FrontEndUI#46:FE_BossDemandIncrement`<br>@0x1c1b7d · uADPCM4Bit 48000/2ch · 1.16825s · one-shot · **decoded** |
| `ui.carousel.left_right` | `FrontEndUI` / `FrontEndUI.dat` | `FE_Carousel_LRSound` | `FrontEndUI#41:FE_Carousel_LR`<br>@0x197441 · uADPCM4Bit 48000/2ch · 0.380271s · one-shot · **decoded** |
| `ui.cascade` | `FrontEndUI` / `FrontEndUI.dat` | `FE_CascadeSound` | `FrontEndUI#48:FE_Cascade`<br>@0x1d5e55 · uADPCM4Bit 48000/2ch · 0.699417s · one-shot · **decoded** |
| `ui.challenge.new_item` | `FrontEndUI` / `FrontEndUI.dat` | `FE_ChallengeNewItemSound` | `FrontEndUI#14:FE_ChallengeNewItem`<br>@0x49d45 · uADPCM4Bit 48000/2ch · 0.947812s · one-shot · **decoded** |
| `ui.confirm` | `FrontEndUI` / `FrontEndUI.dat` | `FE_ChooseSound` | `FrontEndUI#55:FE_Forward`<br>@0x241395 · uADPCM4Bit 48000/2ch · 0.500229s · one-shot · **decoded** |
| `ui.error` | `FrontEndUI` / `FrontEndUI.dat` | `FE_ErrorSound` | `FrontEndUI#1:FE_Error`<br>@0x768c · uADPCM4Bit 48000/2ch · 0.479958s · one-shot · **decoded** |
| `ui.filter` | `FrontEndUI` / `FrontEndUI.dat` | `FE_FilterSound` | `FrontEndUI#42:FE_Filter`<br>@0x19be05 · uADPCM4Bit 48000/2ch · 0.304417s · one-shot · **decoded** |
| `ui.friend.tale_of_the_tape` | `FrontEndUI` / `FrontEndUI.dat` | `FE_FriendTaleOfTheTapeSound` | `FrontEndUI#51:FE_FriendTaleOfTheTape`<br>@0x20addb · uADPCM4Bit 48000/2ch · 2.50625s · one-shot · **decoded** |
| `ui.friend.vs` | `FrontEndUI` / `FrontEndUI.dat` | `FE_FriendVsSound` | `FrontEndUI#50:FE_FriendVs`<br>@0x1e466d · uADPCM4Bit 48000/2ch · 3.181417s · one-shot · **decoded** |
| `ui.garage.colour_move` | `FrontEndUI` / `FrontEndUI.dat` | `FE_GarageColourPickerMoveSound` | `FrontEndUI#5:FE_GarageColourPickerMove`<br>@0x247c4 · uADPCM4Bit 48000/2ch · 0.088104s · one-shot · **decoded** |
| `ui.garage.exit` | `FrontEndUI` / `FrontEndUI.dat` | `FE_GarageExitSound` | `FrontEndUI#6:FE_GarageExit`<br>@0x25912 · uADPCM4Bit 48000/2ch · 0.674708s · one-shot · **decoded** |
| `ui.garage.finish_style.01` | `FrontEndUI` / `FrontEndUI.dat` | `FE_GarageFinishStyleSelect01Sound` | `FrontEndUI#29:FE_GarageFinishStyleSelect01`<br>@0xf5e67 · uADPCM4Bit 48000/2ch · 0.498333s · one-shot · **decoded** |
| `ui.garage.finish_style.02` | `FrontEndUI` / `FrontEndUI.dat` | `FE_GarageFinishStyleSelect02Sound` | `FrontEndUI#12:FE_GarageFinishStyleSelect02`<br>@0x40c30 · uADPCM4Bit 48000/2ch · 0.5s · one-shot · **decoded** |
| `ui.garage.finish_style.03` | `FrontEndUI` / `FrontEndUI.dat` | `FE_GarageFinishStyleSelect03Sound` | `FrontEndUI#16:FE_GarageFinishStyleSelect03`<br>@0x5b551 · uADPCM4Bit 48000/2ch · 0.500792s · one-shot · **decoded** |
| `ui.garage.finish_style.04` | `FrontEndUI` / `FrontEndUI.dat` | `FE_GarageFinishStyleSelect04Sound` | `FrontEndUI#34:FE_GarageFinishStyleSelect04`<br>@0x12c639 · uADPCM4Bit 48000/2ch · 0.500208s · one-shot · **decoded** |
| `ui.garage.respray` | `FrontEndUI` / `FrontEndUI.dat` | `FE_GarageReSpraySound` | `FrontEndUI#2:FE_GarageReSpray`<br>@0xd364 · uADPCM4Bit 48000/2ch · 0.413229s · one-shot · **decoded** |
| `ui.garage.select` | `FrontEndUI` / `FrontEndUI.dat` | `FE_GarageSelectSound` | `FrontEndUI#20:FE_GarageSelect`<br>@0x96485 · uADPCM4Bit 48000/2ch · 0.603896s · one-shot · **decoded** |
| `ui.garage.select_vehicle` | `FrontEndUI` / `FrontEndUI.dat` | `FE_GarageSelectVehicleSound` | `FrontEndUI#28:FE_GarageSelectVehicle`<br>@0xdb78f · uADPCM4Bit 48000/2ch · 2.186667s · one-shot · **decoded** |
| `ui.garage.switch_car` | `FrontEndUI` / `FrontEndUI.dat` | `FE_GarageSwitchCarSound` | `FrontEndUI#31:FE_GarageSwitchCar`<br>@0x10c2c3 · uADPCM4Bit 48000/2ch · 1.312479s · one-shot · **decoded** |
| `ui.graphic.backward` | `FrontEndUI` / `FrontEndUI.dat` | `FE_GraphicBackwardSound` | `FrontEndUI#0:FE_GraphicBackward`<br>@0x1174 · uADPCM4Bit 48000/2ch · 0.522s · one-shot · **decoded** |
| `ui.graphic.forward` | `FrontEndUI` / `FrontEndUI.dat` | `FE_GraphicForwardSound` | `FrontEndUI#54:FE_GraphicForward`<br>@0x239683 · uADPCM4Bit 48000/2ch · 0.645792s · one-shot · **decoded** |
| `ui.graphic.power` | `FrontEndUI` / `FrontEndUI.dat` | `FE_GraphicPowerButtonSound` | `FrontEndUI#52:FE_GraphicPowerButton`<br>@0x229293 · uADPCM4Bit 48000/2ch · 1.013708s · one-shot · **decoded** |
| `ui.lobby.countdown03` | `FrontEndUI` / `FrontEndUI.dat` | `FE_LobbyCountDown03Sound` | `FrontEndUI#17:FE_LobbyCountDown03`<br>@0x61649 · uADPCM4Bit 48000/2ch · 0.365104s · one-shot · **decoded** |
| `ui.lobby.countdown10` | `FrontEndUI` / `FrontEndUI.dat` | `FE_LobbyCountDown10Sound` | `FrontEndUI#32:FE_LobbyCountDown10`<br>@0x11c0bd · uADPCM4Bit 48000/2ch · 0.222875s · one-shot · **decoded** |
| `ui.lobby.join` | `FrontEndUI` / `FrontEndUI.dat` | `FE_LobbyJoinSound` | `FrontEndUI#25:FE_LobbyJoin`<br>@0xbbe69 · uADPCM4Bit 48000/2ch · 0.991604s · one-shot · **decoded** |
| `ui.lobby.leave` | `FrontEndUI` / `FrontEndUI.dat` | `FE_LobbyLeaveSound` | `FrontEndUI#24:FE_LobbyLeave`<br>@0xafb79 · uADPCM4Bit 48000/2ch · 1.007292s · one-shot · **decoded** |
| `ui.lobby.vote_count` | `FrontEndUI` / `FrontEndUI.dat` | `FE_LobbyVoteCountSound` | `FrontEndUI#11:FE_LobbyVoteCount`<br>@0x3e32a · uADPCM4Bit 48000/2ch · 0.211521s · one-shot · **decoded** |
| `ui.lrud` | `FrontEndUI` / `FrontEndUI.dat` | `FE_LRUDSound` | `FrontEndUI#43:FE_LRUD`<br>@0x19f917 · uADPCM4Bit 48000/2ch · 0.407146s · one-shot · **decoded** |
| `ui.modshop.attach` | `FrontEndUI` / `FrontEndUI.dat` | `FE_ModShopAttachSound` | `FrontEndUI#30:FE_ModShopAttach`<br>@0xfbedb · uADPCM4Bit 48000/2ch · 1.344s · one-shot · **decoded** |
| `ui.modshop.remove` | `FrontEndUI` / `FrontEndUI.dat` | `FE_ModShopRemoveSound` | `FrontEndUI#26:FE_ModShopRemove`<br>@0xc7e41 · uADPCM4Bit 48000/2ch · 1.12s · one-shot · **decoded** |
| `ui.navigate.backward` | `FrontEndUI` / `FrontEndUI.dat` | `FE_BackwardSound` | `FrontEndUI#53:FE_Backward`<br>@0x2356cd · uADPCM4Bit 48000/2ch · 0.328875s · one-shot · **decoded** |
| `ui.navigate.forward` | `FrontEndUI` / `FrontEndUI.dat` | `FE_ForwardSound` | `FrontEndUI#55:FE_Forward`<br>@0x241395 · uADPCM4Bit 48000/2ch · 0.500229s · one-shot · **decoded** |
| `ui.notice` | `FrontEndUI` / `FrontEndUI.dat` | `FE_NoticeSound` | `FrontEndUI#57:FE_Notice`<br>@0x2487eb · uADPCM4Bit 48000/2ch · 0.232187s · one-shot · **decoded** |
| `ui.previously.out` | `FrontEndUI` / `FrontEndUI.dat` | `FE_PreviouslyOutSound` | `FrontEndUI#37:FE_PrevOut`<br>@0x165297 · uADPCM4Bit 48000/2ch · 1.921667s · one-shot · **decoded** |
| `ui.previously.reward` | `FrontEndUI` / `FrontEndUI.dat` | `FE_PreviouslyRewardSound` | `FrontEndUI#36:FE_PrevReward`<br>@0x144eef · uADPCM4Bit 48000/2ch · 2.665938s · one-shot · **decoded** |
| `ui.previously.sparks` | `FrontEndUI` / `FrontEndUI.dat` | `FE_PreviouslySparksSound` | `FrontEndUI#38:FE_PrevSparks`<br>@0x17c663 · uADPCM4Bit 48000/2ch · 1.428771s · one-shot · **decoded** |
| `ui.start` | `FrontEndUI` / `FrontEndUI.dat` | `FE_StartSound` | `FrontEndUI#3:FE_Start`<br>@0x12358 · uADPCM4Bit 48000/2ch · 0.917396s · one-shot · **decoded** |
| `ui.stickers.page` | `FrontEndUI` / `FrontEndUI.dat` | `FE_StickersPageSound` | `FrontEndUI#39:FE_StickersPage`<br>@0x18dacb · uADPCM4Bit 48000/2ch · 0.377375s · one-shot · **decoded** |
| `ui.tabs.close` | `FrontEndUI` / `FrontEndUI.dat` | `FE_TabsCloseSound` | `FrontEndUI#40:FE_TabsClose`<br>@0x19240b · uADPCM4Bit 48000/2ch · 0.413771s · one-shot · **decoded** |
| `ui.tabs.open` | `FrontEndUI` / `FrontEndUI.dat` | `FE_TabsOpenSound` | `FrontEndUI#4:FE_TabsOpen`<br>@0x1d502 · uADPCM4Bit 48000/2ch · 0.592854s · one-shot · **decoded** |
| `ui.toggle` | `FrontEndUI` / `FrontEndUI.dat` | `FE_ToggleSound` | `FrontEndUI#10:FE_Toggle`<br>@0x3b604 · uADPCM4Bit 48000/2ch · 0.233125s · one-shot · **decoded** |
| `ui.unlock_content` | `FrontEndUI` / `FrontEndUI.dat` | `HUD_UnlockContentSound` | `FrontEndUI#35:HUD_MPFinalScore`<br>@0x132731 · uADPCM4Bit 48000/2ch · 1.528042s · one-shot · **decoded** |

### 5.3 race (71 events)

| Event | Entity / graph | Component | Wave / provenance |
| --- | --- | --- | --- |
| `race.award.light` | `InGameUI` / `InGameUI.dat` | `HUD_LightAwardSound` | `InGameUI#68:HUD_LightAward`<br>@0x266b0b · uADPCM4Bit 48000/1ch · 0.431583s · one-shot · **decoded** |
| `race.boss.lose` | `InGameUI` / `InGameUI.dat` | `HUD_BossRaceLoseSound` | `InGameUI#77:HUD_BossRaceLose`<br>@0x295f9e · uADPCM4Bit 48000/1ch · 0.132s · one-shot · **decoded** |
| `race.boss.win` | `InGameUI` / `InGameUI.dat` | `HUD_BossRaceWinSound` | `InGameUI#78:HUD_BossRaceWin`<br>@0x296c69 · uADPCM4Bit 48000/1ch · 0.132s · one-shot · **decoded** |
| `race.chain_multiplier` | `InGameUI` / `InGameUI.dat` | `HUD_ChainMultiplierSound` | `InGameUI#27:HUD_ChainMultiplier`<br>@0x108e12 · uADPCM4Bit 48000/1ch · 0.181229s · one-shot · **decoded** |
| `race.challenge.complete` | `InGameUI` / `InGameUIStereo.dat` | `HUD_ChallengeCompleteSound` | `InGameUI#33:HUD_ChallengeComplete`<br>@0x12f26f · uADPCM4Bit 48000/2ch · 1.0365s · one-shot · **decoded** |
| `race.countdown.long` | `InGameUI` / `InGameUI.dat` | `HUD_CountDownSound` | `InGameUI#17:HUD_RaceEndCountDown10`<br>@0x972a2 · uADPCM4Bit 48000/1ch · 0.222875s · one-shot · **decoded** |
| `race.countdown.short` | `InGameUI` / `InGameUI.dat` | `HUD_CountDown03Sound` | `InGameUI#40:HUD_CountDown03`<br>@0x18384d · uADPCM4Bit 48000/1ch · 0.365104s · one-shot · **decoded** |
| `race.drop_light.status` | `InGameUI` / `InGameUI.dat` | `HUD_DropLightStatusSound` | `InGameUI#69:HUD_DropLightStatus`<br>@0x2694d7 · uADPCM4Bit 48000/1ch · 0.945521s · one-shot · **decoded** |
| `race.fans` | `InGameUI` / `InGameUI.dat` | `HUD_FansSound` | `InGameUI#41:HUD_Fans`<br>@0x185ba7 · uADPCM4Bit 48000/1ch · 0.338979s · one-shot · **decoded** |
| `race.fans.count_up` | `InGameUI` / `InGameUI.dat` | `HUD_FansCountUpSound` | `InGameUI#19:HUD_FansCountUp`<br>@0xaec64 · uADPCM4Bit 48000/1ch · 0.099771s · one-shot · **decoded** |
| `race.fans.demand_fail` | `InGameUI` / `InGameUI.dat` | `HUD_FanDemandFailSound` | `InGameUI#53:HUD_FanDemandFail`<br>@0x1e89f7 · uADPCM4Bit 48000/1ch · 1.500604s · one-shot · **decoded** |
| `race.fans.demand_success` | `InGameUI` / `InGameUI.dat` | `HUD_FanDemandSuccessSound` | `InGameUI#54:HUD_FanDemandSuccess`<br>@0x1f1b25 · uADPCM4Bit 48000/1ch · 3.11725s · one-shot · **decoded** |
| `race.fans.gate_pass` | `InGameUI` / `InGameUI.dat` | `HUD_FanGatePassBeepSound` | `InGameUI#61:HUD_FanGatePassBeep`<br>@0x23adf6 · uADPCM4Bit 48000/1ch · 1.154083s · one-shot · **decoded** |
| `race.fans.total_large` | `InGameUI` / `InGameUI.dat` | `HUD_FansTotalLargeSound` | `InGameUI#3:HUD_FansTotalLarge`<br>@0x21abe · uADPCM4Bit 48000/1ch · 2.770667s · one-shot · **decoded** |
| `race.fans.total_medium` | `InGameUI` / `InGameUI.dat` | `HUD_FansTotalMediumSound` | `InGameUI#23:HUD_FansTotalMedium`<br>@0xcb17e · uADPCM4Bit 48000/1ch · 2.473542s · one-shot · **decoded** |
| `race.fans.total_small` | `InGameUI` / `InGameUI.dat` | `HUD_FansTotalSmallSound` | `InGameUI#13:HUD_FansTotalSmall`<br>@0x6e788 · uADPCM4Bit 48000/1ch · 2.167187s · one-shot · **decoded** |
| `race.finish.in` | `InGameUI` / `InGameUIStereo.dat` | `HUD_MPFinishInSound` | `InGameUI#15:HUD_MPFinishIn`<br>@0x7e989 · uADPCM4Bit 48000/2ch · 1.468104s · one-shot · **decoded** |
| `race.finish.in.lfe` | `InGameUI` / `InGameUIStereo.dat` | `HUD_MPFinishInLFESound` | `InGameUI#48:HUD_MPFinishInLFE`<br>@0x1c544c · uADPCM4Bit 48000/1ch · 2.0s · one-shot · **decoded** |
| `race.gift.health` | `InGameUI` / `InGameUIStereo.dat` | `HUD_GiftHealthSound` | `InGameUI#56:HUD_GiftHealth`<br>@0x20c13f · uADPCM4Bit 48000/2ch · 0.684583s · one-shot · **decoded** |
| `race.gift.powerup` | `InGameUI` / `InGameUIStereo.dat` | `HUD_GiftPowerUpSound` | `InGameUI#55:HUD_GiftPowerUp`<br>@0x20488f · uADPCM4Bit 48000/2ch · 0.623917s · one-shot · **decoded** |
| `race.health.low` | `InGameUI` / `InGameUIStereo.dat` | `HUD_HealthLowSound` | `InGameUI#21:HUD_HealthLow`<br>@0xc0491 · uADPCM4Bit 48000/2ch · 0.594562s · one-shot · **decoded** |
| `race.lap.pass` | `InGameUI` / `InGameUIStereo.dat` | `HUD_CheckPassSound` | `InGameUI#59:HUD_CheckPass`<br>@0x21a3b3 · uADPCM4Bit 48000/2ch · 2.514187s · one-shot · **decoded** |
| `race.lock.hard` | `InGameUI` / `InGameUI.dat` | `HUD_LockHardSound` | `InGameUI#29:HUD_LockHard`<br>@0x117900 · uADPCM4Bit 48000/1ch · 0.300146s · one-shot · **decoded** |
| `race.lock.hard_ecm` | `InGameUI` / `InGameUI.dat` | `HUD_LockHardECMSound` | `InGameUI#60:HUD_LockHardECM`<br>@0x2389f7 · uADPCM4Bit 48000/1ch · 0.37175s · one-shot · **decoded** |
| `race.lock.soft` | `InGameUI` / `InGameUI.dat` | `HUD_LockSoftSound` | `InGameUI#34:HUD_LockSoft`<br>@0x13bb0b · uADPCM4Bit 48000/1ch · 0.0725s · one-shot · **decoded** |
| `race.mod.iron_fist` | `InGameUI` / `InGameUI.dat` | `MOD_IronFistSound` | `InGameUI#39:MOD_IronFist`<br>@0x17d6f2 · uADPCM4Bit 48000/1ch · 1.005854s · one-shot · **decoded** |
| `race.mod.scrambler.activate` | `InGameUI` / `InGameUI.dat` | `MOD_ScramblerActivateSound` | `InGameUI#67:MOD_ScramblerActivate`<br>@0x25df05 · uADPCM4Bit 48000/1ch · 1.447667s · one-shot · **decoded** |
| `race.mod.scrambler.deactivate` | `InGameUI` / `InGameUI.dat` | `MOD_ScramblerDeactivateSound` | `InGameUI#66:MOD_ScramblerDeactivate`<br>@0x256c64 · uADPCM4Bit 48000/1ch · 1.184667s · one-shot · **decoded** |
| `race.mod.use.01` | `InGameUI` / `InGameUI.dat` | `HUD_ModUse01Sound` | `InGameUI#31:HUD_ModBeep1`<br>@0x120d90 · uADPCM4Bit 48000/1ch · 0.435292s · one-shot · **decoded** |
| `race.mod.use.02` | `InGameUI` / `InGameUI.dat` | `HUD_ModUse02Sound` | `InGameUI#22:HUD_ModBeep3`<br>@0xc7795 · uADPCM4Bit 48000/1ch · 0.597437s · one-shot · **decoded** |
| `race.mod.use.03` | `InGameUI` / `InGameUI.dat` | `HUD_ModUse03Sound` | `InGameUI#22:HUD_ModBeep3`<br>@0xc7795 · uADPCM4Bit 48000/1ch · 0.597437s · one-shot · **decoded** |
| `race.mode.mm.1point` | `InGameUI` / `InGameUIStereo.dat` | `HUD_MM1PointSound` | `InGameUI#1:HUD_MM1Point`<br>@0xd4ce · uADPCM4Bit 48000/2ch · 0.757646s · one-shot · **decoded** |
| `race.mode.mm.2points` | `InGameUI` / `InGameUIStereo.dat` | `HUD_MM2PointsSound` | `InGameUI#2:HUD_MM2Points`<br>@0x16788 · uADPCM4Bit 48000/2ch · 0.926229s · one-shot · **decoded** |
| `race.mode.mm.5points` | `InGameUI` / `InGameUIStereo.dat` | `HUD_MM5PointsSound` | `InGameUI#0:HUD_MM5Points`<br>@0x1c70 · uADPCM4Bit 48000/2ch · 0.952937s · one-shot · **decoded** |
| `race.mode.mm.count` | `InGameUI` / `InGameUI.dat` | `HUD_MotorMashCountSound` | `InGameUI#37:HUD_MotorMashCount`<br>@0x178738 · uADPCM4Bit 48000/1ch · 0.211125s · one-shot · **decoded** |
| `race.mp.final_score` | `InGameUI` / `InGameUIStereo.dat` | `HUD_MPFinalScoreSound` | `InGameUI#24:HUD_MPFinalScore`<br>@0xda0c6 · uADPCM4Bit 48000/2ch · 1.528042s · one-shot · **decoded** |
| `race.mp.focus_winner` | `InGameUI` / `InGameUIStereo.dat` | `HUD_MPFocusOnWinnerSound` | `InGameUI#6:HUD_MPFocusOnWinner`<br>@0x391b2 · uADPCM4Bit 48000/2ch · 1.129687s · one-shot · **decoded** |
| `race.mp.number_glow` | `InGameUI` / `InGameUIStereo.dat` | `HUD_MPNumberGlowSound` | `InGameUI#18:HUD_MPNumberGlow`<br>@0x98852 · uADPCM4Bit 48000/2ch · 1.840188s · one-shot · **decoded** |
| `race.mp.rank_away` | `InGameUI` / `InGameUIStereo.dat` | `HUD_MPRankAwaySound` | `InGameUI#32:HUD_MPRankAway`<br>@0x1237bf · uADPCM4Bit 48000/2ch · 0.964042s · one-shot · **decoded** |
| `race.perk.switch` | `InGameUI` / `InGameUI.dat` | `HUD_PerkSwitchSound` | `InGameUI#50:HUD_PerkSwitch`<br>@0x1d6562 · uADPCM4Bit 48000/1ch · 0.326188s · one-shot · **decoded** |
| `race.perks.countdown` | `InGameUI` / `InGameUI.dat` | `HUD_PerksCountdownSound` | `InGameUI#5:HUD_Perkscountdown`<br>@0x35703 · uADPCM4Bit 48000/1ch · 0.606521s · one-shot · **decoded** |
| `race.perks.go` | `InGameUI` / `InGameUI.dat` | `HUD_PerksGoSound` | `InGameUI#36:HUD_PerksGo`<br>@0x172a60 · uADPCM4Bit 48000/1ch · 0.96s · one-shot · **decoded** |
| `race.photo` | `InGameUI` / `InGameUIStereo.dat` | `HUD_PhotoTakenSound` | `InGameUI#71:HUD_PhotoTaken`<br>@0x273f72 · uADPCM4Bit 48000/2ch · 0.705917s · one-shot · **decoded** |
| `race.pickup.discard` | `InGameUI` / `InGameUI.dat` | `HUD_DiscardPickupSound` | `InGameUI#42:HUD_DiscardPickup`<br>@0x187c8e · uADPCM4Bit 48000/1ch · 0.361958s · one-shot · **decoded** |
| `race.pickup.discard_decoy` | `InGameUI` / `InGameUI.dat` | `HUD_DiscardDecoyPickupSound` | `InGameUI#57:HUD_PickupsFireError`<br>@0x2145cb · uADPCM4Bit 48000/1ch · 0.468208s · one-shot · **decoded** |
| `race.pickup.fire_error` | `InGameUI` / `InGameUI.dat` | `HUD_PickupsFireErrorSound` | `InGameUI#57:HUD_PickupsFireError`<br>@0x2145cb · uADPCM4Bit 48000/1ch · 0.468208s · one-shot · **decoded** |
| `race.position.first` | `InGameUI` / `InGameUIStereo.dat` | `HUD_MPPlayerFirstSound` | `InGameUI#7:HUD_MPPlayerFirst`<br>@0x46c5a · uADPCM4Bit 48000/2ch · 2.636896s · one-shot · **decoded** |
| `race.position.first.lfe` | `InGameUI` / `InGameUIStereo.dat` | `HUD_MPPlayerFirstLFESound` | `InGameUI#46:HUD_RaceStartCountdownLFE`<br>@0x1ad9e5 · uADPCM4Bit 48000/1ch · 0.3055s · one-shot · **decoded** |
| `race.position.in` | `InGameUI` / `InGameUIStereo.dat` | `HUD_MPPositionInSound` | `InGameUI#30:HUD_MPPositionIn`<br>@0x11962a · uADPCM4Bit 48000/2ch · 0.617104s · one-shot · **decoded** |
| `race.postrace.best` | `InGameUI` / `InGameUI.dat` | `HUD_PostRaceBestSound` | `InGameUI#79:HUD_PostRaceBest`<br>@0x297934 · uADPCM4Bit 48000/1ch · 0.659854s · one-shot · **decoded** |
| `race.postrace.failed` | `InGameUI` / `InGameUI.dat` | `HUD_PostRaceFailedSound` | `InGameUI#80:HUD_PostRaceFailed`<br>@0x29b90b · uADPCM4Bit 48000/1ch · 0.659854s · one-shot · **decoded** |
| `race.postrace.goal_spawn` | `InGameUI` / `InGameUI.dat` | `HUD_PostRaceGoalSpawnSound` | `InGameUI#72:HUD_PostRaceGoalSpawn`<br>@0x27c81e · uADPCM4Bit 48000/1ch · 0.391125s · one-shot · **decoded** |
| `race.postrace.leaderboard_spawn` | `InGameUI` / `InGameUI.dat` | `HUD_PostRaceLeaderboardSpawnSound` | `InGameUI#73:HUD_PostRaceLeaderboardSpawn`<br>@0x27ee0c · uADPCM4Bit 48000/1ch · 0.659854s · one-shot · **decoded** |
| `race.postrace.new_unlocks` | `InGameUI` / `InGameUI.dat` | `HUD_PostRaceNewUnlocksSound` | `InGameUI#74:HUD_PostRaceNewUnlocks`<br>@0x282de3 · uADPCM4Bit 48000/1ch · 0.659854s · one-shot · **decoded** |
| `race.postrace.not_best` | `InGameUI` / `InGameUI.dat` | `HUD_PostRaceNotBestSound` | `InGameUI#75:HUD_PostRaceNotBest`<br>@0x286dba · uADPCM4Bit 48000/1ch · 0.659854s · one-shot · **decoded** |
| `race.postrace.passed` | `InGameUI` / `InGameUI.dat` | `HUD_PostRacePassedSound` | `InGameUI#76:HUD_PostRacePassed`<br>@0x28ad91 · uADPCM4Bit 48000/1ch · 1.840188s · one-shot · **decoded** |
| `race.postrace.passed_light_trail` | `InGameUI` / `InGameUI.dat` | `HUD_PostRacePassedLightTrailSound` | `InGameUI#81:HUD_PostRacePassedLightTrail`<br>@0x29f8e2 · uADPCM4Bit 48000/1ch · 1.474458s · one-shot · **decoded** |
| `race.rank.count` | `InGameUI` / `InGameUI.dat` | `HUD_RankCountUpSound` | `InGameUI#12:HUD_RankCountUp`<br>@0x6e29a · uADPCM4Bit 48000/1ch · 0.05s · one-shot · **decoded** |
| `race.rank.up` | `InGameUI` / `InGameUIStereo.dat` | `HUD_RankUpSound` | `InGameUI#28:HUD_RankUp`<br>@0x109fa2 · uADPCM4Bit 48000/2ch · 1.122937s · one-shot · **decoded** |
| `race.start` | `InGameUI` / `InGameUI.dat` | `HUD_RaceStartSound` | `InGameUI#43:HUD_RaceStart`<br>@0x189fa6 · uADPCM4Bit 48000/1ch · 3.156646s · one-shot · **decoded** |
| `race.start.countdown` | `InGameUI` / `InGameUI.dat` | `HUD_RaceStartCountdownSound` | `InGameUI#44:HUD_RaceStartCountdown`<br>@0x19d0ee · uADPCM4Bit 48000/1ch · 1.040083s · one-shot · **decoded** |
| `race.start.countdown.lfe` | `InGameUI` / `InGameUI.dat` | `HUD_RaceStartCountdownLFESound` | `InGameUI#46:HUD_RaceStartCountdownLFE`<br>@0x1ad9e5 · uADPCM4Bit 48000/1ch · 0.3055s · one-shot · **decoded** |
| `race.start.lfe` | `InGameUI` / `InGameUI.dat` | `HUD_RaceStartLFESound` | `InGameUI#45:HUD_RaceStartLFE`<br>@0x1a35a3 · uADPCM4Bit 48000/1ch · 1.697604s · one-shot · **decoded** |
| `race.start_line.pass` | `InGameUI` / `InGameUIStereo.dat` | `HUD_StartLinePassSound` | `InGameUI#58:HUD_StartLinePass`<br>@0x217333 · uADPCM4Bit 48000/2ch · 0.25s · one-shot · **decoded** |
| `race.stopwatch` | `InGameUI` / `InGameUI.dat` | `HUD_StopwatchSound` | `InGameUI#70:HUD_Stopwatch`<br>@0x26f065 · uADPCM4Bit 48000/1ch · 0.816646s · one-shot · **decoded** |
| `race.unlock_content` | `InGameUI` / `InGameUIStereo.dat` | `HUD_UnlockContentSound` | `InGameUI#20:HUD_UnlockContent`<br>@0xaf617 · uADPCM4Bit 48000/2ch · 1.3975s · one-shot · **decoded** |
| `race.wreck` | `InGameUI` / `InGameUIStereo.dat` | `HUD_WreckedSound` | `InGameUI#35:HUD_Wrecked`<br>@0x13c22a · uADPCM4Bit 48000/2ch · 4.510604s · one-shot · **decoded** |
| `race.wreck.destruction` | `InGameUI` / `InGameUI.dat` | `HUD_DestructionWreckedSound` | `InGameUI#52:HUD_DestructionWrecked`<br>@0x1e04a5 · uADPCM4Bit 48000/1ch · 1.378396s · one-shot · **decoded** |
| `race.wreck.destruction.long` | `InGameUI` / `InGameUI.dat` | `HUD_DestructionWreckedLongShotSound` | `InGameUI#51:HUD_DestructionWreckedLongShot`<br>@0x1d84ff · uADPCM4Bit 48000/1ch · 1.32s · one-shot · **decoded** |
| `race.wreck.lfe` | `InGameUI` / `InGameUIStereo.dat` | `HUD_WreckedLFESound` | `InGameUI#47:HUD_WreckedLFE`<br>@0x1af793 · uADPCM4Bit 48000/1ch · 3.606146s · one-shot · **decoded** |
| `race.zoom.winner.lfe` | `InGameUI` / `InGameUIStereo.dat` | `HUD_ZoomWinnerLFESound` | `InGameUI#49:HUD_ZoomWinnerLFE`<br>@0x1d15b0 · uADPCM4Bit 48000/1ch · 0.823792s · one-shot · **decoded** |

### 5.4 powerup (47 events)

| Event | Entity / graph | Component | Wave / provenance |
| --- | --- | --- | --- |
| `powerup.barge.activate` | `Barge` / `BargeFire.dat` | `BargeFireSound` | `Pickups#10:BargeFire`<br>@0x6bc7d · uADPCM4Bit 48000/1ch · 1.992021s · one-shot · **decoded** |
| `powerup.barge.impact` | `BargeHit` / `BargeHit.dat` | `BargeHitCarSound` | `Pickups#27:BargeHitCar`<br>@0xed27b · uADPCM4Bit 48000/1ch · 1.741125s · one-shot · **decoded** |
| `powerup.barge.impact.shield` | `BargeHit` / `BargeHit.dat` | `BargeHitShieldSound` | `Pickups#16:BargeHitShield`<br>@0x98d85 · uADPCM4Bit 48000/1ch · 0.96525s · one-shot · **decoded** |
| `powerup.barge.last_gasp` | `Barge` / `BargeFire.dat` | `BargeLastGaspSound` | `Pickups#64:BargeLastGasp`<br>@0x222bd4 · uADPCM4Bit 48000/1ch · 2.366958s · one-shot · **decoded** |
| `powerup.bolt.activate` | `BlindFire` / `BlindFireFire.dat` | `BlindFireFireSound` | `Pickups#32:BlindFireFire`<br>@0x113e8c · uADPCM4Bit 48000/1ch · 0.936125s · one-shot · **decoded** |
| `powerup.bolt.impact` | `BlindFireHit` / `BlindFireHit.dat` | `PickupHitCarSound` | `Pickups#18:BlindFireHitCar`<br>@0xa9973 · uADPCM4Bit 48000/1ch · 0.521625s · one-shot · **decoded** |
| `powerup.bolt.impact.shield` | `BlindFireHit` / `BlindFireHit.dat` | `PickupHitShieldSound` | `Pickups#26:BlindFireHitShield`<br>@0xe8c95 · uADPCM4Bit 48000/1ch · 0.721521s · one-shot · **decoded** |
| `powerup.bolt.impact.world` | `BlindFireProjectile` / `BlindFireProjectile.dat` | `PickupHitWorldSound` | `Pickups#38:BlindFireHitWorld`<br>@0x13d8cb · uADPCM4Bit 48000/1ch · 0.368708s · one-shot · **decoded** |
| `powerup.bolt.projectile_loop` | `BlindFireProjectile` / `BlindFireProjectile.dat` | `PickupActiveSound` | `Pickups#7:BlindFireActive`<br>@0x561c4 · uADPCM4Bit 48000/1ch · 1.770042s · loop · **decoded** |
| `powerup.hit.lfe` | `ShockHit` / `ShockHit.dat` | `PickupHitLFESound` | `Pickups#35:Hit_LFE`<br>@0x12ec49 · uADPCM4Bit 48000/1ch · 0.2s · one-shot · **decoded** |
| `powerup.mine.arm` | `BombProjectile` / `BombProjectile.dat` | `BombActiveSound` | `Pickups#23:MineActive`<br>@0xce4c6 · uADPCM4Bit 48000/1ch · 2.694812s · loop · **decoded** |
| `powerup.mine.explode` | `BombProjectile` / `BombProjectile.dat` | `BombExplodeSound` | `Pickups#42:MineExplode`<br>@0x16506e · uADPCM4Bit 48000/1ch · 2.236833s · one-shot · **decoded** |
| `powerup.mine.explode.lfe` | `BombProjectile` / `BombProjectile.dat` | `BombExplodeLFESound` | `Pickups#31:MineExplodeLFE`<br>@0x107d28 · uADPCM4Bit 48000/1ch · 2.0s · one-shot · **decoded** |
| `powerup.mine.impact` | `BombHit` / `BombHit.dat` | `BombHitCarSound` | `Pickups#9:MineHitCar`<br>@0x6521c · uADPCM4Bit 48000/1ch · 1.1s · one-shot · **decoded** |
| `powerup.mine.impact.shield` | `BombHit` / `BombHit.dat` | `BombHitShieldSound` | `Pickups#15:MineHitShield`<br>@0x928f1 · uADPCM4Bit 48000/1ch · 1.039458s · one-shot · **decoded** |
| `powerup.mine.mini.created` | `BombProjectile` / `BombProjectile.dat` | `BombMiniCreatedSound` | `Pickups#63:BombMiniCreated`<br>@0x21b597 · uADPCM4Bit 48000/1ch · 1.222417s · one-shot · **decoded** |
| `powerup.mine.throw.backward` | `Bomb` / `BombFire.dat` | `BombBackwardsFireSound` | `Pickups#12:MineBackwardsFire`<br>@0x7ad7a · uADPCM4Bit 48000/1ch · 1.222417s · one-shot · **decoded** |
| `powerup.mine.throw.forward` | `Bomb` / `BombFire.dat` | `BombForwardsFireSound` | `Pickups#28:MineForwardsFire`<br>@0xf7add · uADPCM4Bit 48000/1ch · 1.278188s · one-shot · **decoded** |
| `powerup.mod.splash_damage` | `Barge` / `BargeFire.dat` | `MOD_SplashDamageFireSound` | `Pickups#41:MOD_SplashDamageFire`<br>@0x1594f8 · uADPCM4Bit 48000/1ch · 1.938562s · one-shot · **decoded** |
| `powerup.nitro.activate` | `NitrousHit` / `NitroHit.dat` | `NitroBackwardFireSound, NitroFireSound, NitroFireSweetenerSound` | `Pickups#48:NitroFire`<br>@0x1a11be · uADPCM4Bit 48000/1ch · 1.639458s · one-shot · **decoded**<br>`Pickups#65:NitroFireSweetener`<br>@0x2310cc · uADPCM4Bit 48000/1ch · 1.145896s · one-shot · **decoded**<br>`Pickups#20:NitroBackwardFire`<br>@0xb6028 · uADPCM4Bit 48000/1ch · 0.949208s · one-shot · **decoded** |
| `powerup.nitro.impact` | `NitrousHit` / `NitroHit.dat` | `NitroHitCarSound` | `Pickups#53:NitroHitCar`<br>@0x1c7ca6 · uADPCM4Bit 48000/1ch · 0.62625s · one-shot · **decoded** |
| `powerup.nitro.loop.flame` | `NitrousHit` / `NitroHit.dat` | `NitroFlameSound` | `Pickups#40:NitroFlameLoop`<br>@0x14cc1a · uADPCM4Bit 48000/1ch · 2.077313s · loop · **decoded** |
| `powerup.nitro.loop.lfe` | `NitrousHit` / `NitroHit.dat` | `NitroLFESound` | `Pickups#6:NitroLFE`<br>@0x50237 · uADPCM4Bit 48000/1ch · 0.987146s · loop · **decoded** |
| `powerup.nitro.loop.low_boost` | `NitrousHit` / `NitroHit.dat` | `NitroLowBoostSound` | `Pickups#49:NitroLowBoost`<br>@0x1ab054 · uADPCM4Bit 48000/1ch · 2.080021s · loop · **decoded** |
| `powerup.nitro.loop.whine` | `NitrousHit` / `NitroHit.dat` | `NitroWhineSound` | `Pickups#37:NitroWhine`<br>@0x1314f4 · uADPCM4Bit 48000/1ch · 2.024458s · loop · **decoded** |
| `powerup.pickup` | `Pickups` / `Pickups.dat` | `PerkPickupSound` | `Pickups#44:PerkPickup`<br>@0x17ee06 · uADPCM4Bit 48000/1ch · 0.498042s · one-shot · **decoded** |
| `powerup.pickup.decoy_loop` | `Pickups` / `Pickups.dat` | `PickupDecoyLoopSound` | `Pickups#62:PickupDecoyLoop`<br>@0x20add1 · uADPCM4Bit 48000/1ch · 2.727083s · loop · **decoded** |
| `powerup.pickup.fan_demand` | `Pickups` / `Pickups.dat` | `FanDemandPickupSound` | `Pickups#0:FanDemandPickup`<br>@0x146c · uADPCM4Bit 48000/1ch · 1.259167s · one-shot · **decoded** |
| `powerup.pickup.loop` | `Pickups` / `Pickups.dat` | `PickupLoopSound` | `Pickups#33:PickupLoop`<br>@0x119933 · uADPCM4Bit 48000/1ch · 2.904229s · loop · **decoded** |
| `powerup.repair.activate` | `Repair` / `RepairHit.dat` | `RepairActivateSound` | `Pickups#19:RepairActivate`<br>@0xacc03 · uADPCM4Bit 48000/1ch · 1.531896s · one-shot · **decoded** |
| `powerup.shield.activate.mod` | `Shield` / `ShieldHit.dat` | `MOD_ShieldActivateSound` | `Pickups#21:MOD_ShieldActivate`<br>@0xbbbf8 · uADPCM4Bit 48000/1ch · 1.892229s · loop · **decoded** |
| `powerup.shield.hit` | `Shield` / `ShieldHit.dat` | `ShieldHitSound` | `Pickups#13:ShieldHit`<br>@0x823b7 · uADPCM4Bit 48000/1ch · 0.700875s · one-shot · **decoded** |
| `powerup.shield.hit_start` | `Shield` / `ShieldHit.dat` | `ShieldHitStartSound` | `Pickups#51:ShieldHitStart`<br>@0x1bd0a0 · uADPCM4Bit 48000/1ch · 0.868417s · one-shot · **decoded** |
| `powerup.shield.hit_stop` | `Shield` / `ShieldHit.dat` | `ShieldHitStopSound` | `Pickups#52:ShieldHitStop`<br>@0x1c24b4 · uADPCM4Bit 48000/1ch · 0.908958s · one-shot · **decoded** |
| `powerup.shield.loop` | `Shield` / `ShieldHit.dat` | `ShieldActiveSound` | `Pickups#1:ShieldActivate`<br>@0x8e45 · uADPCM4Bit 48000/1ch · 1.995833s · loop · **decoded** |
| `powerup.shock.activate` | `Shock` / `ShockFire.dat` | `PickupFireSound` | `Pickups#4:ShockFire`<br>@0x2aefe · uADPCM4Bit 48000/1ch · 3.891167s · one-shot · **decoded** |
| `powerup.shock.activate.lfe` | `Shock` / `ShockFire.dat` | `PickupFireLFESound` | `Pickups#30:ShockFireLFE`<br>@0x102fe9 · uADPCM4Bit 48000/1ch · 0.798063s · one-shot · **decoded** |
| `powerup.shock.explode` | `ShockProjectile` / `ShockProjectile.dat` | `PickupExplodeSound` | `Pickups#2:ShockExplode`<br>@0x14f46 · uADPCM4Bit 48000/1ch · 2.387083s · one-shot · **decoded** |
| `powerup.shock.impact` | `ShockHit` / `ShockHit.dat` | `PickupHitCarSound` | `Pickups#5:ShockHitCar`<br>@0x4274d · uADPCM4Bit 48000/1ch · 2.262979s · one-shot · **decoded** |
| `powerup.shock.impact.shield` | `ShockHit` / `ShockHit.dat` | `PickupHitShieldSound` | `Pickups#3:ShockHitShield`<br>@0x2362d · uADPCM4Bit 48000/1ch · 1.248229s · one-shot · **decoded** |
| `powerup.shunt.activate` | `Shunt` / `ShuntFire.dat` | `ShuntFireSound` | `Pickups#46:ShuntFire`<br>@0x19052b · uADPCM4Bit 48000/1ch · 2.268167s · one-shot · **decoded** |
| `powerup.shunt.charge` | `Shunt` / `ShuntFire.dat` | `ShuntChargeSound` | `Pickups#47:ShuntCharge`<br>@0x19e099 · uADPCM4Bit 48000/1ch · 0.506938s · one-shot · **decoded** |
| `powerup.shunt.impact` | `ShuntHit` / `ShuntHit.dat` | `PickupHitCarSound` | `Pickups#39:ShuntHitCar`<br>@0x13fc88 · uADPCM4Bit 48000/1ch · 2.145521s · one-shot · **decoded** |
| `powerup.shunt.impact.projectile` | `ShuntProjectile` / `ShuntProjectile.dat` | `PickupHitProjectileSound` | `Pickups#43:ShuntHitPerk`<br>@0x1728c4 · uADPCM4Bit 48000/1ch · 2.039771s · one-shot · **decoded** |
| `powerup.shunt.impact.shield` | `ShuntHit` / `ShuntHit.dat` | `PickupHitShieldSound` | `Pickups#25:ShuntHitShield`<br>@0xe2eb5 · uADPCM4Bit 48000/1ch · 0.969708s · one-shot · **decoded** |
| `powerup.shunt.impact.world` | `ShuntProjectile` / `ShuntProjectile.dat` | `PickupHitWorldSound` | `Pickups#29:ShuntHitWorld`<br>@0xff684 · uADPCM4Bit 48000/1ch · 0.592313s · one-shot · **decoded** |
| `powerup.shunt.projectile_loop` | `ShuntProjectile` / `ShuntProjectile.dat` | `PickupActiveSound` | `Pickups#45:ShuntActive`<br>@0x181e44 · uADPCM4Bit 48000/1ch · 2.387646s · loop · **decoded** |

### 5.5 engine (19 events)

| Event | Entity / graph | Component | Wave / provenance |
| --- | --- | --- | --- |
| `engine.decel` | `Race_V8_Race` / `Race_V8_engine.dat` | `Engine7Sound` | `Race_V8#8:RaceV8_Engine_decel`<br>@0x40776 · uADPCM4Bit 48000/1ch · 0.032s · loop · **decodable** |
| `engine.flames_loop` | `Race_V8_Race` / `Race_V8_engine.dat` | `FlamesLoopingSound` | `Car_Common#11:car_fire02L`<br>@0x2e3a2 · uADPCM4Bit 48000/1ch · 2.008s · loop · **decodable** |
| `engine.induction.1500` | `Race_V8_Race` / `Race_V8_engine.dat` | `Induction0Sound` | `Race_V8#17:RaceV8_Induction_1500`<br>@0xb30ca · uADPCM4Bit 48000/1ch · 1.04s · loop · **decodable** |
| `engine.induction.2505` | `Race_V8_Race` / `Race_V8_engine.dat` | `Induction1Sound` | `Race_V8#18:RaceV8_Induction_2505`<br>@0xb955e · uADPCM4Bit 48000/1ch · 1.152s · loop · **decodable** |
| `engine.induction.3495` | `Race_V8_Race` / `Race_V8_engine.dat` | `Induction2Sound` | `Race_V8#19:RaceV8_Induction_3495`<br>@0xc04c6 · uADPCM4Bit 48000/1ch · 0.888s · loop · **decodable** |
| `engine.induction.4500` | `Race_V8_Race` / `Race_V8_engine.dat` | `Induction3Sound` | `Race_V8#20:RaceV8_Induction_4500`<br>@0xc5aa8 · uADPCM4Bit 48000/1ch · 1.12s · loop · **decodable** |
| `engine.induction.5490` | `Race_V8_Race` / `Race_V8_engine.dat` | `Induction4Sound` | `Race_V8#21:RaceV8_Induction_5490`<br>@0xcc6f8 · uADPCM4Bit 48000/1ch · 1.224s · loop · **decodable** |
| `engine.rpm.1500` | `Race_V8_Race` / `Race_V8_engine.dat` | `Engine1Sound` | `Race_V8#2:RaceV8_Engine_1500`<br>@0x18dd4 · uADPCM4Bit 48000/1ch · 1.04s · loop · **decoded** |
| `engine.rpm.1995` | `Race_V8_Race` / `Race_V8_engine.dat` | `Engine2Sound` | `Race_V8#3:RaceV8_Engine_1995`<br>@0x1f268 · uADPCM4Bit 48000/1ch · 1.08s · loop · **decoded** |
| `engine.rpm.3015` | `Race_V8_Race` / `Race_V8_engine.dat` | `Engine3Sound` | `Race_V8#4:RaceV8_Engine_3015`<br>@0x25ada · uADPCM4Bit 48000/1ch · 0.84s · loop · **decoded** |
| `engine.rpm.4005` | `Race_V8_Race` / `Race_V8_engine.dat` | `Engine4Sound` | `Race_V8#5:RaceV8_Engine_4005`<br>@0x2ac18 · uADPCM4Bit 48000/1ch · 0.992s · loop · **decoded** |
| `engine.rpm.4995` | `Race_V8_Race` / `Race_V8_engine.dat` | `Engine5Sound` | `Race_V8#6:RaceV8_Engine_4995`<br>@0x30c08 · uADPCM4Bit 48000/1ch · 1.2s · loop · **decoded** |
| `engine.rpm.6000` | `Race_V8_Race` / `Race_V8_engine.dat` | `Engine6Sound` | `Race_V8#7:RaceV8_Engine_6000`<br>@0x38014 · uADPCM4Bit 48000/1ch · 1.4s · loop · **decoded** |
| `engine.steam_loop` | `Race_V8_Race` / `Race_V8_engine.dat` | `SteamLoopingSound` | `Car_Common#7:steam_loop`<br>@0x194ff · uADPCM4Bit 48000/1ch · 1.208s · loop · **decodable** |
| `engine.supercharger.00` | `Race_V8_Race` / `Race_V8_engine.dat` | `Supercharger0Sound` | `Race_V8#22:RaceV8_sc_00`<br>@0xd3d56 · uADPCM4Bit 48000/1ch · 0.936s · loop · **decodable** |
| `engine.supercharger.02` | `Race_V8_Race` / `Race_V8_engine.dat` | `Supercharger1Sound` | `Race_V8#23:RaceV8_sc_02`<br>@0xd97dc · uADPCM4Bit 48000/1ch · 0.968s · loop · **decodable** |
| `engine.supercharger.04` | `Race_V8_Race` / `Race_V8_engine.dat` | `Supercharger2Sound` | `Race_V8#24:RaceV8_sc_04`<br>@0xdf57a · uADPCM4Bit 48000/1ch · 0.928s · loop · **decodable** |
| `engine.supercharger.06` | `Race_V8_Race` / `Race_V8_engine.dat` | `Supercharger3Sound` | `Race_V8#25:RaceV8_sc_06`<br>@0xe4f3a · uADPCM4Bit 48000/1ch · 0.968s · loop · **decodable** |
| `engine.supercharger.08` | `Race_V8_Race` / `Race_V8_engine.dat` | `Supercharger4Sound` | `Race_V8#0:RaceV8_sc_08`<br>@0x7f4 · uADPCM4Bit 48000/1ch · 1.128s · loop · **decodable** |

### 5.6 tyre (12 events)

| Event | Entity / graph | Component | Wave / provenance |
| --- | --- | --- | --- |
| `tyre.dry.road` | `Wheel_dry` / `Wheel_Dry.dat` | `Asphalt_Road_Sound` | `Wheel_dry#6:Asphalt_Road`<br>@0x68294 · uADPCM4Bit 48000/1ch · 2.944s · loop · **decoded** |
| `tyre.dry.skid0` | `Wheel_dry` / `Wheel_Dry.dat` | `Asphalt_Skid0_Sound` | `Wheel_dry#3:Asphalt_Lateral_1`<br>@0x325a6 · uADPCM4Bit 48000/1ch · 3.072s · loop · **decoded** |
| `tyre.dry.skid1` | `Wheel_dry` / `Wheel_Dry.dat` | `Asphalt_Skid1_Sound` | `Wheel_dry#4:Asphalt_Lateral_2`<br>@0x44eae · uADPCM4Bit 48000/1ch · 2.872s · loop · **decoded** |
| `tyre.dry.skid2` | `Wheel_dry` / `Wheel_Dry.dat` | `Asphalt_Skid2_Sound` | `Wheel_dry#5:Asphalt_Lateral_3`<br>@0x56460 · uADPCM4Bit 48000/1ch · 2.96s · loop · **decoded** |
| `tyre.dry.spin` | `Wheel_dry` / `Wheel_Dry.dat` | `Asphalt_Spin_Sound` | `Wheel_dry#7:Asphalt_Spin`<br>@0x79f3c · uADPCM4Bit 48000/1ch · 4.432s · loop · **decoded** |
| `tyre.offroad.foliage.road` | `Wheel_offroad` / `Wheel_offroad.dat` | `Foliage_Road_Sound` | `Wheel_offroad#8:Foliage_road`<br>@0x60bc4 · uADPCM4Bit 48000/1ch · 4.0s · loop · **decoded** |
| `tyre.offroad.grass.road` | `Wheel_offroad` / `Wheel_offroad.dat` | `Grass_Road_Sound` | `Wheel_offroad#4:Dirt_road`<br>@0x18af6 · uADPCM4Bit 48000/1ch · 2.992s · loop · **decoded** |
| `tyre.offroad.grass.skid` | `Wheel_offroad` / `Wheel_offroad.dat` | `Grass_Skid_Sound` | `Wheel_offroad#5:Dirt_skid`<br>@0x2ac42 · uADPCM4Bit 48000/1ch · 3.872s · loop · **decoded** |
| `tyre.offroad.gravel.road` | `Wheel_offroad` / `Wheel_offroad.dat` | `Gravel_Road_Sound` | `Wheel_offroad#10:Gravel_road`<br>@0x8f7be · uADPCM4Bit 48000/1ch · 3.496s · loop · **decoded** |
| `tyre.offroad.gravel.skid` | `Wheel_offroad` / `Wheel_offroad.dat` | `Gravel_Skid_Sound` | `Wheel_offroad#11:Gravel_skid`<br>@0xa49c4 · uADPCM4Bit 48000/1ch · 2.968s · loop · **decoded** |
| `tyre.offroad.sand.road` | `Wheel_offroad` / `Wheel_offroad.dat` | `Sand_Road_Sound` | `Wheel_offroad#14:Sand_road`<br>@0xd875f · uADPCM4Bit 48000/1ch · 3.172333s · loop · **decoded** |
| `tyre.offroad.sand.skid` | `Wheel_offroad` / `Wheel_offroad.dat` | `Sand_Skid_Sound` | `Wheel_offroad#15:Sand_skid`<br>@0xeba33 · uADPCM4Bit 48000/1ch · 2.626313s · loop · **decoded** |

### 5.7 collision (14 events)

| Event | Entity / graph | Component | Wave / provenance |
| --- | --- | --- | --- |
| `collision.world.concrete` | `CollisionWorld` / `CollisionWorld.dat` | `Concrete_LargeCollisionSound` | `DO_concrete_large#0:imp_concl01`<br>@0x120 · uADPCM4Bit 48000/1ch · 0.959833s · one-shot · **decoded**<br>`DO_concrete_large#1:imp_concl02`<br>@0x5df8 · uADPCM4Bit 48000/1ch · 0.991833s · one-shot · **decoded**<br>`DO_concrete_large#2:imp_concl03`<br>@0xbde8 · uADPCM4Bit 48000/1ch · 0.996583s · one-shot · **decoded** |
| `collision.world.concrete_fence_chain` | `CollisionWorld` / `CollisionWorld.dat` | `concrete_fence_chainCollisionSound` | `DO_concrete_fence_chain#1:imp_conchain01`<br>@0x4e1d · uADPCM4Bit 48000/1ch · 0.810333s · one-shot · **decoded**<br>`DO_concrete_fence_chain#2:imp_conchain02`<br>@0x9c85 · uADPCM4Bit 48000/1ch · 0.866875s · one-shot · **decoded**<br>`DO_concrete_fence_chain#0:imp_conchain03`<br>@0x120 · uADPCM4Bit 48000/1ch · 0.795083s · one-shot · **decoded** |
| `collision.world.concrete_fence_plastic` | `CollisionWorld` / `CollisionWorld.dat` | `concrete_fence_plasticCollisionSound` | `DO_concrete_fence_plastic#0:imp_conplast01`<br>@0x120 · uADPCM4Bit 48000/1ch · 0.789875s · one-shot · **decoded**<br>`DO_concrete_fence_plastic#1:imp_conplast02`<br>@0x4d99 · uADPCM4Bit 48000/1ch · 0.800667s · one-shot · **decoded**<br>`DO_concrete_fence_plastic#2:imp_conplast03`<br>@0x9b1a · uADPCM4Bit 48000/1ch · 0.668708s · one-shot · **decoded** |
| `collision.world.glass` | `CollisionWorld` / `CollisionWorld.dat` | `glass_hitCollisionSound` | `DO_glass_hit#0:imp_glasshit01`<br>@0x120 · uADPCM4Bit 48000/1ch · 0.611313s · one-shot · **decoded**<br>`DO_glass_hit#1:imp_glasshit02`<br>@0x3c53 · uADPCM4Bit 48000/1ch · 0.731625s · one-shot · **decoded**<br>`DO_glass_hit#2:imp_glasshit03`<br>@0x8320 · uADPCM4Bit 48000/1ch · 0.6715s · one-shot · **decoded** |
| `collision.world.metal` | `CollisionWorld` / `CollisionWorld.dat` | `metal_sheetCollisionSound` | `DO_metal_sheet#0:imp_metsheet01`<br>@0x120 · uADPCM4Bit 48000/1ch · 0.825812s · one-shot · **decoded**<br>`DO_metal_sheet#1:imp_metsheet02`<br>@0x5114 · uADPCM4Bit 48000/1ch · 0.781333s · one-shot · **decoded**<br>`DO_metal_sheet#2:imp_metsheet03`<br>@0x9ca6 · uADPCM4Bit 48000/1ch · 0.682771s · one-shot · **decoded** |
| `collision.world.metal_armco` | `CollisionWorld` / `CollisionWorld.dat` | `metal_armcoCollisionSound` | `DO_metal_armco#0:imp_armco01`<br>@0x1b8 · uADPCM4Bit 48000/1ch · 0.656375s · one-shot · **decoded**<br>`DO_metal_armco#1:imp_armco02`<br>@0x414d · uADPCM4Bit 48000/1ch · 0.667125s · one-shot · **decoded**<br>`DO_metal_armco#2:imp_armco03`<br>@0x81ea · uADPCM4Bit 48000/1ch · 0.617375s · one-shot · **decoded** |
| `collision.world.metal_fence_chain` | `CollisionWorld` / `CollisionWorld.dat` | `metal_fence_chainlinkCollisionSound` | `DO_metal_fence_chainlink#1:imp_metal_fence_chainlink01`<br>@0x8108 · uADPCM4Bit 48000/1ch · 1.306583s · one-shot · **decoded**<br>`DO_metal_fence_chainlink#2:imp_metal_fence_chainlink02`<br>@0xff64 · uADPCM4Bit 48000/1ch · 1.299875s · one-shot · **decoded**<br>`DO_metal_fence_chainlink#0:imp_metal_fence_chainlink03`<br>@0x120 · uADPCM4Bit 48000/1ch · 1.322021s · one-shot · **decoded** |
| `collision.world.metal_fence_slatted` | `CollisionWorld` / `CollisionWorld.dat` | `metal_railingCollisionSound` | `DO_metal_railing#1:imp_metrailng01`<br>@0x52a0 · uADPCM4Bit 48000/1ch · 0.6025s · one-shot · **decoded**<br>`DO_metal_railing#2:imp_metrailng02`<br>@0x8cec · uADPCM4Bit 48000/1ch · 0.636521s · one-shot · **decoded**<br>`DO_metal_railing#0:imp_metrailng03`<br>@0x120 · uADPCM4Bit 48000/1ch · 0.842458s · one-shot · **decoded** |
| `collision.world.metal_fence_solid` | `CollisionWorld` / `CollisionWorld.dat` | `metal_solid_mediumCollisionSound` | `DO_metal_solid_medium#1:imp_metalsolidm01`<br>@0x561b · uADPCM4Bit 48000/1ch · 0.808896s · one-shot · **decoded**<br>`DO_metal_solid_medium#2:imp_metalsolidm02`<br>@0xa462 · uADPCM4Bit 48000/1ch · 0.813438s · one-shot · **decoded**<br>`DO_metal_solid_medium#0:imp_metalsolidm03`<br>@0x120 · uADPCM4Bit 48000/1ch · 0.877458s · one-shot · **decoded** |
| `collision.world.metal_hollow` | `CollisionWorld` / `CollisionWorld.dat` | `metal_hollow_largeCollisionSound` | `DO_metal_hollow_large#0:imp_metholol01`<br>@0x120 · uADPCM4Bit 48000/1ch · 1.574875s · one-shot · **decoded**<br>`DO_metal_hollow_large#1:imp_metholol02`<br>@0x9986 · uADPCM4Bit 48000/1ch · 1.540333s · one-shot · **decoded**<br>`DO_metal_hollow_large#2:imp_metholol03`<br>@0x12e92 · uADPCM4Bit 48000/1ch · 1.643083s · one-shot · **decoded** |
| `collision.world.metal_solid_post` | `CollisionWorld` / `CollisionWorld.dat` | `metal_post_tallCollisionSound` | `DO_metal_post_tall#1:imp_metpostt01`<br>@0x2dc2 · uADPCM4Bit 48000/1ch · 0.473021s · one-shot · **decoded**<br>`DO_metal_post_tall#2:imp_metpostt02`<br>@0x5b8d · uADPCM4Bit 48000/1ch · 0.463708s · one-shot · **decoded**<br>`DO_metal_post_tall#0:imp_metpostt03`<br>@0x120 · uADPCM4Bit 48000/1ch · 0.460208s · one-shot · **decoded** |
| `collision.world.rubber` | `CollisionWorld` / `CollisionWorld.dat` | `rubber_tyreCollisionSound` | `DO_rubber_tyre#1:imp_tyre01`<br>@0x2183 · uADPCM4Bit 48000/1ch · 0.288875s · one-shot · **decoded**<br>`DO_rubber_tyre#2:imp_tyre02`<br>@0x3d84 · uADPCM4Bit 48000/1ch · 0.303292s · one-shot · **decoded**<br>`DO_rubber_tyre#0:imp_tyre03`<br>@0x120 · uADPCM4Bit 48000/1ch · 0.333833s · one-shot · **decoded** |
| `collision.world.vegetation` | `CollisionWorld` / `CollisionWorld.dat` | `vegetation_hedgeCollisionSound` | `DO_vegetation_hedge#0:imp_veghedge01`<br>@0x120 · uADPCM4Bit 48000/1ch · 1.022917s · one-shot · **decoded**<br>`DO_vegetation_hedge#1:imp_veghedge02`<br>@0x6428 · uADPCM4Bit 48000/1ch · 1.12375s · one-shot · **decoded**<br>`DO_vegetation_hedge#2:imp_veghedge03`<br>@0xd0db · uADPCM4Bit 48000/1ch · 1.003042s · one-shot · **decoded** |
| `collision.world.wood` | `CollisionWorld` / `CollisionWorld.dat` | `wood_fenceCollisionSound` | `DO_wood_fence#0:imp_wood_fence01`<br>@0x120 · uADPCM4Bit 48000/1ch · 0.738875s · one-shot · **decoded**<br>`DO_wood_fence#1:imp_wood_fence02`<br>@0x48b3 · uADPCM4Bit 48000/1ch · 0.904833s · one-shot · **decoded**<br>`DO_wood_fence#2:imp_wood_fence03`<br>@0xa042 · uADPCM4Bit 48000/1ch · 0.768917s · one-shot · **decoded** |

### 5.8 music (89 events)

| Event | Entity / graph | Component | Wave / provenance |
| --- | --- | --- | --- |
| `music.boss.fill.ahead` | `Music_Boss` / `Music_Boss.dat` | `BossFill2` | `BossMusic_NS#3:MX_OOO_Trans_Ahead`<br>@0x3e428 · uADPCM4Bit 48000/2ch · 1.714271s · one-shot · **decodable** |
| `music.boss.fill.behind` | `Music_Boss` / `Music_Boss.dat` | `BossFill1` | `BossMusic_NS#0:MX_OOO_Trans_Behind`<br>@0x16c · uADPCM4Bit 48000/2ch · 1.714271s · one-shot · **decodable** |
| `music.boss.loop.close` | `Music_Boss` / `Music_Boss.dat` | `BossCloseLoop` | `InGameCustomMusic#10:MX_OOO_Neutral`<br>@0xbf5800 · uADPCM4Bit 48000/2ch · 27.428333s · loop · **unsupported** (streaming-container) |
| `music.boss.loop.losing` | `Music_Boss` / `Music_Boss.dat` | `BossLosingLoop` | `InGameCustomMusic#9:MX_OOO_Boss_Lead`<br>@0xaaa000 · uADPCM4Bit 48000/2ch · 27.428333s · loop · **unsupported** (streaming-container) |
| `music.boss.loop.sync` | `Music_Boss` / `Music_Boss.dat` | `BossSyncLoop` | `InGameCustomMusic#21:MX_OOO_sync_loop`<br>@0x1177800 · PCM16 48000/2ch · Nones · loop · **unsupported** (streaming-container) |
| `music.boss.loop.winning` | `Music_Boss` / `Music_Boss.dat` | `BossWinningLoop` | `InGameCustomMusic#11:MX_OOO_Player_Leads`<br>@0xd41000 · uADPCM4Bit 48000/2ch · 27.428333s · loop · **unsupported** (streaming-container) |
| `music.boss.pass.boss` | `Music_Boss` / `Music_Boss.dat` | `BossPassPlayerFill` | `BossMusic_NS#1:MX_OOO_Boss_Passes`<br>@0x14d00 · uADPCM4Bit 48000/2ch · 1.714271s · one-shot · **decodable** |
| `music.boss.pass.player` | `Music_Boss` / `Music_Boss.dat` | `PlayerPassBossFill` | `BossMusic_NS#2:MX_OOO_Player_Passes`<br>@0x29894 · uADPCM4Bit 48000/2ch · 1.714271s · one-shot · **decodable** |
| `music.boss.start.01` | `Music_Boss` / `Music_Boss.dat` | `Boss1StartSound` | `InGameCustomMusic#17:MX_OOO_Start_Shannon`<br>@0x102b800 · uADPCM4Bit 48000/2ch · 6.857083s · one-shot · **unsupported** (streaming-container) |
| `music.boss.start.02` | `Music_Boss` / `Music_Boss.dat` | `Boss2StartSound` | `InGameCustomMusic#14:MX_OOO_Start_Khan`<br>@0xf32800 · uADPCM4Bit 48000/2ch · 6.857083s · one-shot · **unsupported** (streaming-container) |
| `music.boss.start.03` | `Music_Boss` / `Music_Boss.dat` | `Boss3StartSound` | `InGameCustomMusic#16:MX_OOO_Start_Rhymer`<br>@0xfd8800 · uADPCM4Bit 48000/2ch · 6.857083s · one-shot · **unsupported** (streaming-container) |
| `music.boss.start.04` | `Music_Boss` / `Music_Boss.dat` | `Boss4StartSound` | `InGameCustomMusic#13:MX_OOO_Start_Drake`<br>@0xedf800 · uADPCM4Bit 48000/2ch · 6.857083s · one-shot · **unsupported** (streaming-container) |
| `music.boss.start.05` | `Music_Boss` / `Music_Boss.dat` | `Boss5StartSound` | `InGameCustomMusic#15:MX_OOO_Start_Natalya`<br>@0xf85800 · uADPCM4Bit 48000/2ch · 6.857083s · one-shot · **unsupported** (streaming-container) |
| `music.boss.start.06` | `Music_Boss` / `Music_Boss.dat` | `Boss6StartSound` | `InGameCustomMusic#18:MX_OOO_Start_Talon`<br>@0x107e800 · uADPCM4Bit 48000/2ch · 6.857083s · one-shot · **unsupported** (streaming-container) |
| `music.boss.start.07` | `Music_Boss` / `Music_Boss.dat` | `Boss7StartSound` | `InGameCustomMusic#19:MX_OOO_Start_Twins`<br>@0x10d1800 · uADPCM4Bit 48000/2ch · 6.857083s · one-shot · **unsupported** (streaming-container) |
| `music.boss.start.08` | `Music_Boss` / `Music_Boss.dat` | `Boss8StartSound` | `InGameCustomMusic#12:MX_OOO_Start_Carver`<br>@0xe8c800 · uADPCM4Bit 48000/2ch · 6.857083s · one-shot · **unsupported** (streaming-container) |
| `music.boss.start.09` | `Music_Boss` / `Music_Boss.dat` | `Boss9StartSound` | `InGameCustomMusic#20:MX_OOO_Start_Uber`<br>@0x1124800 · uADPCM4Bit 48000/2ch · 6.857083s · one-shot · **unsupported** (streaming-container) |
| `music.checkpoint.high_to_med` | `Music_Checkpoint` / `Music_Checkpoint.dat` | `CheckpointHightoMedSound` | `CheckpointMusic_NS#0:MX_Chk_High_to_Med`<br>@0x204 · uADPCM4Bit 48000/2ch · 1.845938s · one-shot · **decodable** |
| `music.checkpoint.last` | `Music_Checkpoint` / `Music_Checkpoint.dat` | `CheckpointLastCheckpointSound` | `CheckpointMusic_NS#5:MX_Chk_Trans_Last`<br>@0x6fb86 · uADPCM4Bit 48000/2ch · 1.846146s · one-shot · **decodable** |
| `music.checkpoint.loop.high` | `Music_Checkpoint` / `Music_Checkpoint.dat` | `CheckpointHighIntensityLoop` | `InGameCustomMusic#0:MX_Chk_High`<br>@0x800 · uADPCM4Bit 48000/2ch · 29.538333s · loop · **unsupported** (streaming-container) |
| `music.checkpoint.loop.last` | `Music_Checkpoint` / `Music_Checkpoint.dat` | `CheckpointLastCheckpointLoop` | `InGameCustomMusic#1:MX_Chk_Last`<br>@0x165800 · uADPCM4Bit 48000/2ch · 29.538333s · loop · **unsupported** (streaming-container) |
| `music.checkpoint.loop.low` | `Music_Checkpoint` / `Music_Checkpoint.dat` | `CheckpointLowIntensityLoop` | `InGameCustomMusic#2:MX_Chk_Low`<br>@0x2ca800 · uADPCM4Bit 48000/2ch · 29.538333s · loop · **unsupported** (streaming-container) |
| `music.checkpoint.loop.med` | `Music_Checkpoint` / `Music_Checkpoint.dat` | `CheckpointMedIntensityLoop` | `InGameCustomMusic#3:MX_Chk_Med`<br>@0x42f800 · uADPCM4Bit 48000/2ch · 29.538333s · loop · **unsupported** (streaming-container) |
| `music.checkpoint.loop.sync` | `Music_Checkpoint` / `Music_Checkpoint.dat` | `CheckpointSyncLoop` | `InGameCustomMusic#4:MX_Chk_sync_loop`<br>@0x594800 · PCM16 48000/2ch · Nones · loop · **unsupported** (streaming-container) |
| `music.checkpoint.low_to_med` | `Music_Checkpoint` / `Music_Checkpoint.dat` | `CheckpointLowtoMedSound` | `CheckpointMusic_NS#1:MX_Chk_Low_to_Med`<br>@0x1671e · uADPCM4Bit 48000/2ch · 1.846146s · one-shot · **decodable** |
| `music.checkpoint.med_to_high` | `Music_Checkpoint` / `Music_Checkpoint.dat` | `CheckpointMedtoHighSound` | `CheckpointMusic_NS#2:MX_Chk_Med_to_High`<br>@0x2cc38 · uADPCM4Bit 48000/2ch · 1.846146s · one-shot · **decodable** |
| `music.checkpoint.med_to_low` | `Music_Checkpoint` / `Music_Checkpoint.dat` | `CheckpointMedtoLowSound` | `CheckpointMusic_NS#3:MX_Chk_Med_to_Low`<br>@0x43152 · uADPCM4Bit 48000/2ch · 1.846167s · one-shot · **decodable** |
| `music.checkpoint.start` | `Music_Checkpoint` / `Music_Checkpoint.dat` | `CheckpointStartSound` | `CheckpointMusic_NS#4:MX_Chk_Start`<br>@0x5966c · uADPCM4Bit 48000/2ch · 1.846146s · one-shot · **decodable** |
| `music.destruction.high_to_med` | `Music_Destruction` / `Music_Destruction.dat` | `DestructionHightoMedSound` | `DestructionMusic_NS#0:MX_Destruct_High_to_Med`<br>@0x1b8 · uADPCM4Bit 48000/2ch · 1.935479s · one-shot · **decodable** |
| `music.destruction.loop.high` | `Music_Destruction` / `Music_Destruction.dat` | `DestructionHighIntensityLoop` | `InGameCustomMusic#5:MX_Destruct_High`<br>@0x5eb800 · uADPCM4Bit 48000/2ch · 30.967667s · loop · **unsupported** (streaming-container) |
| `music.destruction.loop.low` | `Music_Destruction` / `Music_Destruction.dat` | `DestructionLowIntensityLoop` | `InGameCustomMusic#6:MX_Destruct_Low`<br>@0x762000 · uADPCM4Bit 48000/2ch · 30.967667s · loop · **unsupported** (streaming-container) |
| `music.destruction.loop.med` | `Music_Destruction` / `Music_Destruction.dat` | `DestructionMedIntensityLoop` | `InGameCustomMusic#7:MX_Destruct_Med`<br>@0x8d8800 · uADPCM4Bit 48000/2ch · 30.967667s · loop · **unsupported** (streaming-container) |
| `music.destruction.loop.sync` | `Music_Destruction` / `Music_Destruction.dat` | `DestructionSyncLoop` | `InGameCustomMusic#8:MX_Destruct_sync_loop`<br>@0xa4f000 · PCM16 48000/2ch · Nones · loop · **unsupported** (streaming-container) |
| `music.destruction.low_to_med` | `Music_Destruction` / `Music_Destruction.dat` | `DestructionLowtoMedSound` | `DestructionMusic_NS#1:MX_Destruct_Low_to_Med`<br>@0x17818 · uADPCM4Bit 48000/2ch · 1.935479s · one-shot · **decodable** |
| `music.destruction.med_to_high` | `Music_Destruction` / `Music_Destruction.dat` | `DestructionMedtoHighSound` | `DestructionMusic_NS#2:MX_Destruct_Med_to_High`<br>@0x2ee78 · uADPCM4Bit 48000/2ch · 1.935479s · one-shot · **decodable** |
| `music.destruction.med_to_low` | `Music_Destruction` / `Music_Destruction.dat` | `DestructionMedtoLowSound` | `DestructionMusic_NS#3:MX_Destruct_Med_to_Low`<br>@0x464d8 · uADPCM4Bit 48000/2ch · 1.935479s · one-shot · **decodable** |
| `music.destruction.start` | `Music_Destruction` / `Music_Destruction.dat` | `DestructionStartSound` | `DestructionMusic_NS#4:MX_Destruct_Start`<br>@0x5db38 · uADPCM4Bit 48000/2ch · 1.935479s · one-shot · **decodable** |
| `music.ingame.track00` | `Music` / `Music_Controller.dat` | `InGameMusic00` | `InGameMusic#0:AtomicMoog`<br>@0x800 · uADPCM4Bit 48000/2ch · 363.4525s · one-shot · **unsupported** (streaming-container) |
| `music.ingame.track01` | `Music` / `Music_Controller.dat` | `InGameMusic01` | `InGameMusic#6:Bump`<br>@0x4a4e800 · uADPCM4Bit 48000/2ch · 223.838896s · one-shot · **unsupported** (streaming-container) |
| `music.ingame.track02` | `Music` / `Music_Controller.dat` | `InGameMusic02` | `InGameMusic#7:Coleen`<br>@0x54e0000 · uADPCM4Bit 48000/2ch · 339.981667s · one-shot · **unsupported** (streaming-container) |
| `music.ingame.track03` | `Music` / `Music_Controller.dat` | `InGameMusic03` | `InGameMusic#8:Delucid`<br>@0x64ed000 · uADPCM4Bit 48000/2ch · 245.280833s · one-shot · **unsupported** (streaming-container) |
| `music.ingame.track04` | `Music` / `Music_Controller.dat` | `InGameMusic04` | `InGameMusic#9:DemNaLikeMe`<br>@0x7081800 · uADPCM4Bit 48000/2ch · 312.461167s · one-shot · **unsupported** (streaming-container) |
| `music.ingame.track05` | `Music` / `Music_Controller.dat` | `InGameMusic05` | `InGameMusic#10:EverythingIsUnderControl`<br>@0x7f42000 · uADPCM4Bit 48000/2ch · 181.580417s · one-shot · **unsupported** (streaming-container) |
| `music.ingame.track06` | `Music` / `Music_Controller.dat` | `InGameMusic06` | `InGameMusic#11:GadgetFunk`<br>@0x87d4800 · uADPCM4Bit 48000/2ch · 246.551208s · one-shot · **unsupported** (streaming-container) |
| `music.ingame.track07` | `Music` / `Music_Controller.dat` | `InGameMusic07` | `InGameMusic#12:HarvestDance`<br>@0x9378800 · uADPCM4Bit 48000/2ch · 195.643979s · one-shot · **unsupported** (streaming-container) |
| `music.ingame.track08` | `Music` / `Music_Controller.dat` | `InGameMusic08` | `InGameMusic#13:LetThereBeLight`<br>@0x9cb5000 · uADPCM4Bit 48000/2ch · 324.469729s · one-shot · **unsupported** (streaming-container) |
| `music.ingame.track09` | `Music` / `Music_Controller.dat` | `InGameMusic09` | `InGameMusic#14:MakeItSo`<br>@0xac06800 · uADPCM4Bit 48000/2ch · 269.07675s · one-shot · **unsupported** (streaming-container) |
| `music.ingame.track10` | `Music` / `Music_Controller.dat` | `InGameMusic10` | `InGameMusic#15:Nothing2Step2`<br>@0xb8ba800 · uADPCM4Bit 48000/2ch · 375.173021s · one-shot · **unsupported** (streaming-container) |
| `music.ingame.track11` | `Music` / `Music_Controller.dat` | `InGameMusic11` | `InGameMusic#16:OnTheRun`<br>@0xca70800 · uADPCM4Bit 48000/2ch · 364.577917s · one-shot · **unsupported** (streaming-container) |
| `music.ingame.track12` | `Music` / `Music_Controller.dat` | `InGameMusic12` | `InGameMusic#17:PatPong`<br>@0xdba6800 · uADPCM4Bit 48000/2ch · 253.942813s · one-shot · **unsupported** (streaming-container) |
| `music.ingame.track13` | `Music` / `Music_Controller.dat` | `InGameMusic13` | `InGameMusic#18:RedLaserBeam`<br>@0xe7a3800 · uADPCM4Bit 48000/2ch · 208.551125s · one-shot · **unsupported** (streaming-container) |
| `music.ingame.track14` | `Music` / `Music_Controller.dat` | `InGameMusic14` | `InGameMusic#19:Stompbox`<br>@0xf17c000 · uADPCM4Bit 48000/2ch · 338.756562s · one-shot · **unsupported** (streaming-container) |
| `music.ingame.track15` | `Music` / `Music_Controller.dat` | `InGameMusic15` | `InGameMusic#20:SWAG`<br>@0x1017a000 · uADPCM4Bit 48000/2ch · 290.4535s · one-shot · **unsupported** (streaming-container) |
| `music.ingame.track16` | `Music` / `Music_Controller.dat` | `InGameMusic16` | `InGameMusic#21:TeQuiero`<br>@0x10f30800 · uADPCM4Bit 48000/2ch · 291.140292s · one-shot · **unsupported** (streaming-container) |
| `music.ingame.track17` | `Music` / `Music_Controller.dat` | `InGameMusic17` | `InGameMusic#22:ThatGirl`<br>@0x11cef000 · uADPCM4Bit 48000/2ch · 200.97675s · one-shot · **unsupported** (streaming-container) |
| `music.ingame.track18` | `Music` / `Music_Controller.dat` | `InGameMusic18` | `InGameMusic#1:BLUR_track1`<br>@0x1129000 · uADPCM4Bit 48000/2ch · 237.94s · one-shot · **unsupported** (streaming-container) |
| `music.ingame.track19` | `Music` / `Music_Controller.dat` | `InGameMusic19` | `InGameMusic#2:BLUR_track2`<br>@0x1c64800 · uADPCM4Bit 48000/2ch · 257.764s · one-shot · **unsupported** (streaming-container) |
| `music.ingame.track20` | `Music` / `Music_Controller.dat` | `InGameMusic20` | `InGameMusic#3:BLUR_track3`<br>@0x2890000 · uADPCM4Bit 48000/2ch · 251.962875s · one-shot · **unsupported** (streaming-container) |
| `music.ingame.track21` | `Music` / `Music_Controller.dat` | `InGameMusic21` | `InGameMusic#4:BLUR_track4`<br>@0x3475000 · uADPCM4Bit 48000/2ch · 228.562667s · one-shot · **unsupported** (streaming-container) |
| `music.ingame.track22` | `Music` / `Music_Controller.dat` | `InGameMusic22` | `InGameMusic#5:BLUR_track5`<br>@0x3f3f800 · uADPCM4Bit 48000/2ch · 234.224021s · one-shot · **unsupported** (streaming-container) |
| `music.menu.loading` | `Music` / `Music_Controller.dat` | `MenuLoadingLoop` | `MenuMusic_NS#3:menu_loading`<br>@0xb1994 · uADPCM4Bit 48000/2ch · 14.2955s · loop · **decodable** |
| `music.menu.opening` | `Music` / `Music_Controller.dat` | `MenuOpeningLoop` | `MenuMusic#1:menu_opening`<br>@0xb6000 · uADPCM4Bit 48000/2ch · 96.0s · loop · **unsupported** (streaming-container) |
| `music.menu.press_start` | `Music` / `Music_Controller.dat` | `PressStartLoop` | `MenuMusic#2:menu_press_start`<br>@0x53e800 · uADPCM4Bit 48000/2ch · 32.0s · loop · **unsupported** (streaming-container) |
| `music.menu.press_start_fill` | `Music` / `Music_Controller.dat` | `PressStartFill` | `MenuMusic_NS#2:menu_press_start_fill`<br>@0x996d4 · uADPCM4Bit 48000/2ch · 2.0s · one-shot · **decodable** |
| `music.menu.race_fail_fill` | `Music` / `Music_Controller.dat` | `RaceFailFill` | `MenuMusic_NS#0:race_fail_fill`<br>@0x16c · uADPCM4Bit 48000/2ch · 6.448s · one-shot · **decodable** |
| `music.menu.race_pass_fill` | `Music` / `Music_Controller.dat` | `RacePassFill` | `MenuMusic_NS#1:race_pass_fill`<br>@0x4e03c · uADPCM4Bit 48000/2ch · 6.239792s · one-shot · **decodable** |
| `music.menu.variation0` | `Music` / `Music_Controller.dat` | `MenuVariation0Loop` | `MenuMusic#4:menu_variation0`<br>@0x71f800 · uADPCM4Bit 48000/2ch · 88.8s · loop · **unsupported** (streaming-container) |
| `music.menu.variation1` | `Music` / `Music_Controller.dat` | `MenuVariation1Loop` | `MenuMusic#5:menu_variation1`<br>@0xb51000 · uADPCM4Bit 48000/2ch · 88.738292s · loop · **unsupported** (streaming-container) |
| `music.menu.variation2` | `Music` / `Music_Controller.dat` | `MenuVariation2Loop` | `MenuMusic#6:menu_variation2`<br>@0xf81800 · uADPCM4Bit 48000/2ch · 92.16s · loop · **unsupported** (streaming-container) |
| `music.menu.variation3` | `Music` / `Music_Controller.dat` | `MenuVariation3Loop` | `MenuMusic#7:menu_variation3`<br>@0x13db800 · uADPCM4Bit 48000/2ch · 65.454688s · loop · **unsupported** (streaming-container) |
| `music.race.finished` | `Music` / `Music_Controller.dat` | `RaceFinishedLoop` | `MenuMusic#0:race_finished`<br>@0x800 · uADPCM4Bit 48000/2ch · 15.0s · loop · **unsupported** (streaming-container) |
| `music.vista.Amboy` | `Music` / `Music_Controller.dat` | `VistaAmboy` | `VistaMusic#1:MX_Vis_Amboy`<br>@0xcf000 · uADPCM4Bit 48000/2ch · 14.22025s · one-shot · **unsupported** (streaming-container) |
| `music.vista.AmboyBowl` | `Music` / `Music_Controller.dat` | `VistaAmboyBowl` | `VistaMusic#13:MX_Vis_Amboy_Bowl`<br>@0x957000 · uADPCM4Bit 48000/2ch · 10.703333s · one-shot · **unsupported** (streaming-container) |
| `music.vista.BarcelonaBowl` | `Music` / `Music_Controller.dat` | `VistaBarcelonaBowl` | `VistaMusic#14:MX_Vis_Barcelona_Bowl`<br>@0x9d8800 · uADPCM4Bit 48000/2ch · 10.662667s · one-shot · **unsupported** (streaming-container) |
| `music.vista.BarcelonaGracia` | `Music` / `Music_Controller.dat` | `VistaBarcelonaGracia` | `VistaMusic#2:MX_Vis_Barcelona`<br>@0x17b000 · uADPCM4Bit 48000/2ch · 14.817958s · one-shot · **unsupported** (streaming-container) |
| `music.vista.BarcelonaOval` | `Music` / `Music_Controller.dat` | `VistaBarcelonaOval` | `VistaMusic#3:MX_Vis_Barcelona_Oval`<br>@0x22e800 · uADPCM4Bit 48000/2ch · 14.296s · one-shot · **unsupported** (streaming-container) |
| `music.vista.Brighton` | `Music` / `Music_Controller.dat` | `VistaBrighton` | `VistaMusic#4:MX_Vis_Brighton`<br>@0x2db800 · uADPCM4Bit 48000/2ch · 14.999125s · one-shot · **unsupported** (streaming-container) |
| `music.vista.Hackney` | `Music` / `Music_Controller.dat` | `VistaHackney` | `VistaMusic#5:MX_Vis_Hackney`<br>@0x391000 · uADPCM4Bit 48000/2ch · 13.660083s · one-shot · **unsupported** (streaming-container) |
| `music.vista.HollywoodHills` | `Music` / `Music_Controller.dat` | `VistaHollywoodHills` | `VistaMusic#6:MX_Vis_Hollywood_Hills`<br>@0x436800 · uADPCM4Bit 48000/2ch · 15.272042s · one-shot · **unsupported** (streaming-container) |
| `music.vista.LADocks` | `Music` / `Music_Controller.dat` | `VistaLADocks` | `VistaMusic#7:MX_Vis_LA_Docks`<br>@0x4ef800 · uADPCM4Bit 48000/2ch · 14.975708s · one-shot · **unsupported** (streaming-container) |
| `music.vista.LADowntown` | `Music` / `Music_Controller.dat` | `VistaLADowntown` | `VistaMusic#15:MX_Vis_LA_Downtown`<br>@0xa59800 · uADPCM4Bit 48000/2ch · 15.134833s · one-shot · **unsupported** (streaming-container) |
| `music.vista.LAFigureOfEight` | `Music` / `Music_Controller.dat` | `VistaLAFigureOfEight` | `VistaMusic#17:MX_Vis_LA_FigureOfEight`<br>@0xbc7000 · uADPCM4Bit 48000/2ch · 18.672s · one-shot · **unsupported** (streaming-container) |
| `music.vista.LAHighRise` | `Music` / `Music_Controller.dat` | `VistaLAHighRise` | `VistaMusic#16:MX_Vis_LA_HighRise`<br>@0xb10800 · uADPCM4Bit 48000/2ch · 15.095333s · one-shot · **unsupported** (streaming-container) |
| `music.vista.LARiver` | `Music` / `Music_Controller.dat` | `VistaLARiver` | `VistaMusic#8:MX_Vis_LA_River`<br>@0x5a4800 · uADPCM4Bit 48000/2ch · 16.509479s · one-shot · **unsupported** (streaming-container) |
| `music.vista.MountHaruna` | `Music` / `Music_Controller.dat` | `VistaMountHaruna` | `VistaMusic#9:MX_Vis_Mount_Haruna`<br>@0x66c800 · uADPCM4Bit 48000/2ch · 15.47225s · one-shot · **unsupported** (streaming-container) |
| `music.vista.NYDumbo` | `Music` / `Music_Controller.dat` | `VistaNYDumbo` | `VistaMusic#10:MX_Vis_NY_Dumbo`<br>@0x727800 · uADPCM4Bit 48000/2ch · 17.142875s · one-shot · **unsupported** (streaming-container) |
| `music.vista.SFRussianHill` | `Music` / `Music_Controller.dat` | `VistaSFRussianHill` | `VistaMusic#11:MX_Vis_Russian_Hill`<br>@0x7f7000 · uADPCM4Bit 48000/2ch · 14.092167s · one-shot · **unsupported** (streaming-container) |
| `music.vista.SFSausalito` | `Music` / `Music_Controller.dat` | `VistaSFSausalito` | `VistaMusic#12:MX_Vis_Sausalito`<br>@0x8a1800 · uADPCM4Bit 48000/2ch · 14.991646s · one-shot · **unsupported** (streaming-container) |
| `music.vista.TokyoShutoko` | `Music` / `Music_Controller.dat` | `VistaTokyoShutoko` | `VistaMusic#0:MX_Vis_Tokyo`<br>@0x800 · uADPCM4Bit 48000/2ch · 17.061854s · one-shot · **unsupported** (streaming-container) |

### 5.9 ambience (38 events)

| Event | Entity / graph | Component | Wave / provenance |
| --- | --- | --- | --- |
| `ambience.amboy` | `AMB_Amboy` / `Amboy_Ambient.dat` | `Front_Ambient_Loop, Front_Core_Loop, Front_Intro, Rear_Ambient_Loop, Rear_Core_Loop, Rear_Intro` | `ENV_Amboy_ST#2:amb_amboy_front_intro`<br>@0x4e0000 · uADPCM4Bit 48000/2ch · 20.022125s · one-shot · **unsupported** (streaming-container)<br>`ENV_Amboy_ST#0:amb_amboy_rear_intro`<br>@0x800 · uADPCM4Bit 48000/2ch · 20.022125s · one-shot · **unsupported** (streaming-container)<br>`ENV_Amboy_Mem#1:amb_amboy_front_air`<br>@0x3ca3c · uADPCM4Bit 48000/2ch · 5.013333s · loop · **decodable**<br>`ENV_Amboy_Mem#0:amb_amboy_rear_air`<br>@0xd4 · uADPCM4Bit 48000/2ch · 5.013333s · loop · **decodable**<br>`ENV_Amboy_ST#1:amb_Amboy_front`<br>@0xf2800 · uADPCM4Bit 48000/2ch · 83.181104s · loop · **unsupported** (streaming-container)<br>`ENV_Amboy_ST#3:amb_Amboy_rear`<br>@0x5d2000 · uADPCM4Bit 48000/2ch · 83.181104s · loop · **unsupported** (streaming-container) |
| `ambience.birds_takeoff` | `AMB_Birds_Takeoff` / `AMB_Birds_Takeoff.dat` | `BirdsTakeoffSound` | `ENV_Birds_takeoff#0:env_birds_takeoff`<br>@0x88 · uADPCM4Bit 48000/1ch · 2.136375s · one-shot · **decodable** |
| `ambience.boathorn` | `AMB_Boathorn` / `AMB_Boathorn.dat` | `BoathornSound` | `ENV_boathorn#0:env_boathorn`<br>@0x88 · uADPCM4Bit 48000/1ch · 5.653104s · one-shot · **decodable** |
| `ambience.cafe_sign` | `AMB_Cafe_Sign` / `AMB_Cafe_Sign.dat` | `CafeSignSound` | `ENV_cafe_sign#0:env_neon_buzz_loop`<br>@0x88 · uADPCM4Bit 48000/1ch · 8.054833s · loop · **decodable** |
| `ambience.church_bell` | `AMB_Church_Bell` / `AMB_Church_bell.dat` | `BellSound` | `ENV_church_bell#0:env_church_bell`<br>@0x88 · uADPCM4Bit 48000/1ch · 35.339292s · one-shot · **decodable** |
| `ambience.cicadas` | `AMB_Cicadas` / `AMB_Cicadas.dat` | `CicadasSound` | `ENV_cicadas#0:env_cicadas`<br>@0x88 · uADPCM4Bit 48000/1ch · 4.777208s · loop · **decodable** |
| `ambience.crowd_large` | `AMB_Crowd_Large` / `AMB_Crowd_Large.dat` | `CrowdSound01, CrowdSound02` | `ENV_crowd_large#1:env_crowd_large_01`<br>@0x21391 · uADPCM4Bit 48000/1ch · 9.552729s · loop · **decodable**<br>`ENV_crowd_large#0:env_crowd_large_02`<br>@0xd4 · uADPCM4Bit 48000/1ch · 5.488542s · loop · **decodable** |
| `ambience.crowd_medium` | `AMB_Crowd_medium` / `AMB_Crowd_medium.dat` | `CrowdSound01, CrowdSound02, CrowdSound03` | `ENV_crowd_medium#1:env_crowd_medium_01`<br>@0x64c5b · uADPCM4Bit 48000/1ch · 38.6435s · loop · **decodable**<br>`ENV_crowd_medium#2:env_crowd_medium_02`<br>@0x14e47a · uADPCM4Bit 48000/1ch · 26.0s · loop · **decodable**<br>`ENV_crowd_medium#0:env_crowd_medium_03`<br>@0x120 · uADPCM4Bit 48000/1ch · 16.664667s · loop · **decodable** |
| `ambience.crowd_party` | `AMB_Crowd_Party` / `AMB_Crowd_Party.dat` | `Party1Sound, Party2Sound, Party3Sound, Party4Sound, Party5Sound, Party6Sound` | `ENV_crowd_party#0:env_crowd_party_01`<br>@0x204 · uADPCM4Bit 48000/1ch · 11.999479s · loop · **decodable**<br>`ENV_crowd_party#1:env_crowd_party_02`<br>@0x48a34 · uADPCM4Bit 48000/1ch · 7.999667s · loop · **decodable**<br>`ENV_crowd_party#2:env_crowd_party_03`<br>@0x78fac · uADPCM4Bit 48000/1ch · 9.600021s · loop · **decodable**<br>`ENV_crowd_party#3:env_crowd_party_04`<br>@0xb2ff5 · uADPCM4Bit 48000/1ch · 6.857146s · loop · **decodable**<br>`ENV_crowd_party#4:env_crowd_party_05`<br>@0xdc6f4 · uADPCM4Bit 48000/1ch · 6.857146s · loop · **decodable**<br>`ENV_crowd_party#5:env_crowd_party_06`<br>@0x105df3 · uADPCM4Bit 48000/1ch · 5.647062s · loop · **decodable** |
| `ambience.crowd_small` | `AMB_Crowd_Small` / `AMB_Crowd_Small.dat` | `CrowdSound01, CrowdSound02, CrowdSound03` | `ENV_crowd_small#1:env_crowd_small_01`<br>@0x79ebc · uADPCM4Bit 48000/1ch · 33.140021s · loop · **decodable**<br>`ENV_crowd_small#2:env_crowd_small_02`<br>@0x1422dc · uADPCM4Bit 48000/1ch · 17.508667s · loop · **decodable**<br>`ENV_crowd_small#0:env_crowd_small_03`<br>@0x120 · uADPCM4Bit 48000/1ch · 20.164417s · loop · **decodable** |
| `ambience.docks_crane` | `AMB_Docks_Crane` / `AMB_Docks_Crane.dat` | `CraneSound, MetalCreakSound` | `ENV_docks_crane#1:env_docks_craneloop`<br>@0x1064f · uADPCM4Bit 48000/1ch · 2.096938s · loop · **decodable**<br>`ENV_docks_crane#2:env_docks_crate_squeak1`<br>@0x1d11c · uADPCM4Bit 48000/1ch · 1.969792s · one-shot · **decodable**<br>`ENV_docks_crane#3:env_docks_crate_squeak2`<br>@0x28faa · uADPCM4Bit 48000/1ch · 2.08025s · one-shot · **decodable**<br>`ENV_docks_crane#4:env_docks_crate_squeak3`<br>@0x358eb · uADPCM4Bit 48000/1ch · 2.871521s · one-shot · **decodable**<br>`ENV_docks_crane#5:env_docks_crate_squeak4`<br>@0x46e9d · uADPCM4Bit 48000/1ch · 2.5265s · one-shot · **decodable**<br>`ENV_docks_crane#0:env_docks_crate_squeak5`<br>@0x204 · uADPCM4Bit 48000/1ch · 2.69175s · one-shot · **decodable** |
| `ambience.docks_loading` | `AMB_Docks_Loading` / `AMB_Docks_Loading_loop.dat` | `DocksLoadingSound` | `ENV_docks_loading#0:env_docks_loading`<br>@0x88 · uADPCM4Bit 48000/1ch · 73.206604s · loop · **decodable** |
| `ambience.docks_siren` | `AMB_Docks_Siren` / `AMB_Docks_siren_loop.dat` | `DocksSirenSound` | `ENV_docks_siren#0:env_docks_siren`<br>@0x88 · uADPCM4Bit 48000/1ch · 40.449688s · loop · **decodable** |
| `ambience.docks_trucks` | `AMB_Docks_Trucks` / `AMB_Docks_trucks_loop.dat` | `DocksTrucksSound` | `ENV_docks_trucks#0:env_docks_trucks`<br>@0x88 · uADPCM4Bit 48000/1ch · 65.372833s · loop · **decodable** |
| `ambience.electricity_arcs` | `AMB_Electricity_arcs` / `AMB_Electricity_arcs.dat` | `ElectricityLoop` | `ENV_Electricity_arcs#0:env_electricity_arcs`<br>@0x88 · uADPCM4Bit 48000/1ch · 2.721729s · loop · **decodable** |
| `ambience.flare` | `AMB_Flare` / `AMB_Flare.dat` | `FlareSound` | `ENV_flare#0:env_flare`<br>@0x88 · uADPCM4Bit 48000/1ch · 2.248833s · loop · **decodable** |
| `ambience.floodgate` | `AMB_Floodgate` / `AMB_Floodgate.dat` | `FloodgateSound` | `ENV_floodgate#0:env_floodgate`<br>@0x88 · uADPCM4Bit 48000/1ch · 9.866792s · loop · **decodable** |
| `ambience.funfair` | `AMB_Funfair` / `AMB_Funfair.dat` | `AAAAAAAAAAAAAAAHHHSound, FunFairSound` | `ENV_funfair#1:env_funfair2`<br>@0x10d1a · uADPCM4Bit 48000/1ch · 5.416604s · loop · **decodable**<br>`ENV_funfair#2:env_funfairscream01`<br>@0x318e1 · uADPCM4Bit 48000/1ch · 1.061021s · one-shot · **decodable**<br>`ENV_funfair#3:env_funfairscream02`<br>@0x37f85 · uADPCM4Bit 48000/1ch · 0.869521s · one-shot · **decodable**<br>`ENV_funfair#4:env_funfairscream03`<br>@0x3d3ba · uADPCM4Bit 48000/1ch · 0.971708s · one-shot · **decodable**<br>`ENV_funfair#0:env_funfairscream05`<br>@0x1b8 · uADPCM4Bit 48000/1ch · 2.764292s · one-shot · **decodable** |
| `ambience.hackney` | `AMB_Hackney` / `Hackney_Ambient.dat` | `Front_Ambient_Loop, Front_Core_Loop, Front_Intro, Rear_Ambient_Loop, Rear_Core_Loop, Rear_Intro` | `ENV_Hackney_ST#1:amb_hackney_front_intro`<br>@0x441800 · uADPCM4Bit 48000/2ch · 20.02s · one-shot · **unsupported** (streaming-container)<br>`ENV_Hackney_ST#3:amb_hackney_rear_intro`<br>@0x974800 · uADPCM4Bit 48000/2ch · 20.02s · one-shot · **unsupported** (streaming-container)<br>`ENV_Hackney_Mem#1:amb_hackney_front_air`<br>@0x26908 · uADPCM4Bit 48000/2ch · 3.186125s · loop · **decodable**<br>`ENV_Hackney_Mem#0:amb_hackney_rear_air`<br>@0xd4 · uADPCM4Bit 48000/2ch · 3.186125s · loop · **decodable**<br>`ENV_Hackney_ST#0:amb_hackney_front`<br>@0x800 · uADPCM4Bit 48000/2ch · 90.09s · loop · **unsupported** (streaming-container)<br>`ENV_Hackney_ST#2:amb_hackney_rear`<br>@0x533800 · uADPCM4Bit 48000/2ch · 90.09s · loop · **unsupported** (streaming-container) |
| `ambience.helicopter` | `AMB_Helicopter` / `AMB_Helicopter.dat` | `helicopter_loop` | `ENV_Helicopter#0:env_helicopter`<br>@0x88 · uADPCM4Bit 48000/1ch · 1.487333s · loop · **decodable** |
| `ambience.hollywood_hills` | `AMB_Hollywood_Hills` / `Hollywood_Hills_Ambient.dat` | `Front_Ambient_Loop, Front_Core_Loop, Front_Intro, Rear_Ambient_Loop, Rear_Core_Loop, Rear_Intro` | `ENV_Hollywood_Hills_ST#2:amb_hwoodhills_front_intro`<br>@0x533800 · uADPCM4Bit 48000/2ch · 20.02s · one-shot · **unsupported** (streaming-container)<br>`ENV_Hollywood_Hills_ST#0:amb_hwoodhills_rear_intro`<br>@0x800 · uADPCM4Bit 48000/2ch · 20.02s · one-shot · **unsupported** (streaming-container)<br>`ENV_Hollywood_Hills_Mem#1:amb_hwoodhills_front_air`<br>@0x3c8b0 · uADPCM4Bit 48000/2ch · 5.005s · loop · **decodable**<br>`ENV_Hollywood_Hills_Mem#0:amb_hwoodhills_rear_air`<br>@0xd4 · uADPCM4Bit 48000/2ch · 5.005s · loop · **decodable**<br>`ENV_Hollywood_Hills_ST#1:amb_hwoodhills_front`<br>@0xf2800 · uADPCM4Bit 48000/2ch · 90.09s · loop · **unsupported** (streaming-container)<br>`ENV_Hollywood_Hills_ST#3:amb_hwoodhills_rear`<br>@0x625800 · uADPCM4Bit 48000/2ch · 90.09s · loop · **unsupported** (streaming-container) |
| `ambience.la_docks` | `AMB_LA_Docks` / `LA_Docks_Ambient.dat` | `Front_Ambient_Loop, Front_Core_Loop, Front_Intro, Rear_Ambient_Loop, Rear_Core_Loop, Rear_Intro` | `ENV_LADocks_ST#2:amb_LADocks_front_intro`<br>@0x439800 · uADPCM4Bit 48000/2ch · 20.053354s · one-shot · **unsupported** (streaming-container)<br>`ENV_LADocks_ST#0:amb_LADocks_rear_intro`<br>@0x800 · uADPCM4Bit 48000/2ch · 20.053354s · one-shot · **unsupported** (streaming-container)<br>`ENV_LADocks_Mem#1:amb_LADocks_front_air`<br>@0x1fa2c · uADPCM4Bit 48000/2ch · 2.612333s · loop · **decodable**<br>`ENV_LADocks_Mem#0:amb_LADocks_rear_air`<br>@0xd4 · uADPCM4Bit 48000/2ch · 2.612333s · loop · **decodable**<br>`ENV_LADocks_ST#1:amb_LADocks_front`<br>@0xf3000 · uADPCM4Bit 48000/2ch · 69.362083s · loop · **unsupported** (streaming-container)<br>`ENV_LADocks_ST#3:amb_LADocks_rear`<br>@0x52c000 · uADPCM4Bit 48000/2ch · 69.362083s · loop · **unsupported** (streaming-container) |
| `ambience.la_downtown_highrise` | `AMB_LA_Downtown_Highrise` / `LA_Downtown_Ambient_Highrise.dat` | `Front_Ambient_Loop, Front_Core_Loop, Front_Intro, Rear_Ambient_Loop, Rear_Core_Loop, Rear_Intro` | `ENV_LA_Downtown_ST#2:amb_LADowntown_front_intro`<br>@0x533800 · uADPCM4Bit 48000/2ch · 20.02s · one-shot · **unsupported** (streaming-container)<br>`ENV_LA_Downtown_ST#0:amb_LADowntown_rear_intro`<br>@0x800 · uADPCM4Bit 48000/2ch · 20.02s · one-shot · **unsupported** (streaming-container)<br>`ENV_LA_Downtown_MEM#1:amb_LADowntown_front_air`<br>@0x243a6 · uADPCM4Bit 48000/2ch · 2.993083s · loop · **decodable**<br>`ENV_LA_Downtown_MEM#0:amb_LADowntown_rear_air`<br>@0xd4 · uADPCM4Bit 48000/2ch · 2.993083s · loop · **decodable**<br>`ENV_LA_Downtown_ST#1:amb_LADowntown_front`<br>@0xf2800 · uADPCM4Bit 48000/2ch · 90.09s · loop · **unsupported** (streaming-container)<br>`ENV_LA_Downtown_ST#3:amb_LADowntown_rear`<br>@0x625800 · uADPCM4Bit 48000/2ch · 90.09s · loop · **unsupported** (streaming-container) |
| `ambience.level_crossing` | `AMB_Level_Crossing` / `AMB_Level_Crossing.dat` | `level_crossing_loop` | `ENV_level_crossing#0:env_level_crossing`<br>@0x88 · uADPCM4Bit 48000/1ch · 1.76s · loop · **decodable** |
| `ambience.mt_haruna` | `AMB_MT_Haruna` / `Mt_Haruna_Ambient.dat` | `Front_Ambient_Loop, Front_Core_Loop, Front_Intro, Rear_Ambient_Loop, Rear_Core_Loop, Rear_Intro` | `ENV_Mt_Haruna_ST#2:amb_mt_haruna_front_intro`<br>@0x533800 · uADPCM4Bit 48000/2ch · 20.02s · one-shot · **unsupported** (streaming-container)<br>`ENV_Mt_Haruna_ST#0:amb_mt_haruna_rear_intro`<br>@0x800 · uADPCM4Bit 48000/2ch · 20.02s · one-shot · **unsupported** (streaming-container)<br>`ENV_Mt_Haruna_Mem#1:amb_mt_haruna_front_air`<br>@0x2a13c · uADPCM4Bit 48000/2ch · 3.477333s · loop · **decodable**<br>`ENV_Mt_Haruna_Mem#0:amb_mt_haruna_rear_air`<br>@0xd4 · uADPCM4Bit 48000/2ch · 3.477333s · loop · **decodable**<br>`ENV_Mt_Haruna_ST#1:amb_mt_haruna_front`<br>@0xf2800 · uADPCM4Bit 48000/2ch · 90.09s · loop · **unsupported** (streaming-container)<br>`ENV_Mt_Haruna_ST#3:amb_mt_haruna_rear`<br>@0x625800 · uADPCM4Bit 48000/2ch · 90.09s · loop · **unsupported** (streaming-container) |
| `ambience.neon` | `AMB_Neon` / `AMB_Neon.dat` | `NeonLoopSound` | `ENV_neon#0:env_neon`<br>@0x88 · uADPCM4Bit 48000/1ch · 1.933979s · loop · **decodable** |
| `ambience.oil_derrick` | `AMB_Oil_Derrick` / `AMB_Oil_Derrick.dat` | `oil_derrick_loop` | `ENV_Oil_Derrick#0:env_oil_derrick`<br>@0x88 · uADPCM4Bit 48000/1ch · 3.224s · loop · **decodable** |
| `ambience.oil_flames` | `AMB_Oil_Flames` / `AMB_Oil_flames.dat` | `Environmental_oil_flames_loop` | `ENV_Oil_flames#0:env_oil_flames`<br>@0x88 · uADPCM4Bit 48000/1ch · 5.726375s · loop · **decodable** |
| `ambience.oval` | `AMB_Oval` / `Oval_Ambient.dat` | `Front_Ambient_Loop, Front_Core_Loop, Front_Intro, Rear_Ambient_Loop, Rear_Core_Loop, Rear_Intro` | `ENV_Oval_ST#2:amb_oval_front_intro`<br>@0x43c000 · uADPCM4Bit 48000/2ch · 20.02s · one-shot · **unsupported** (streaming-container)<br>`ENV_Oval_ST#0:amb_oval_rear_intro`<br>@0x800 · uADPCM4Bit 48000/2ch · 20.02s · one-shot · **unsupported** (streaming-container)<br>`ENV_Oval_Mem#1:amb_oval_front_air`<br>@0x3ca3c · uADPCM4Bit 48000/2ch · 5.013333s · loop · **decodable**<br>`ENV_Oval_Mem#0:amb_oval_rear_air`<br>@0xd4 · uADPCM4Bit 48000/2ch · 5.013333s · loop · **decodable**<br>`ENV_Oval_ST#1:amb_oval_front`<br>@0xf2800 · uADPCM4Bit 48000/2ch · 69.629229s · loop · **unsupported** (streaming-container)<br>`ENV_Oval_ST#3:amb_oval_rear`<br>@0x52e000 · uADPCM4Bit 48000/2ch · 69.629229s · loop · **unsupported** (streaming-container) |
| `ambience.sf_russian_hill` | `AMB_SF_Russian_Hill` / `SF_Russian_Hill_Ambient.dat` | `Front_Ambient_Loop, Front_Core_Loop, Front_Intro, Rear_Ambient_Loop, Rear_Core_Loop, Rear_Intro` | `ENV_SF_Hill_ST#2:amb_russian_hill_front_intro`<br>@0x533800 · uADPCM4Bit 48000/2ch · 20.02s · one-shot · **unsupported** (streaming-container)<br>`ENV_SF_Hill_ST#0:amb_russian_hill_rear_intro`<br>@0x800 · uADPCM4Bit 48000/2ch · 20.02s · one-shot · **unsupported** (streaming-container)<br>`ENV_SF_Hill_Mem#1:amb_russian_hill_front_air`<br>@0x2845c · uADPCM4Bit 48000/2ch · 3.328s · loop · **decodable**<br>`ENV_SF_Hill_Mem#0:amb_russian_hill_rear_air`<br>@0xd4 · uADPCM4Bit 48000/2ch · 3.328s · loop · **decodable**<br>`ENV_SF_Hill_ST#1:amb_russian_hill_front`<br>@0xf2800 · uADPCM4Bit 48000/2ch · 90.09s · loop · **unsupported** (streaming-container)<br>`ENV_SF_Hill_ST#3:amb_russian_hill_rear`<br>@0x625800 · uADPCM4Bit 48000/2ch · 90.09s · loop · **unsupported** (streaming-container) |
| `ambience.siren` | `AMB_Siren` / `AMB_Siren.dat` | `Siren01Sound, Siren02Sound, Siren03Sound` | `ENV_Siren#1:env_siren_01`<br>@0x30b9 · uADPCM4Bit 48000/1ch · 0.708937s · loop · **decodable**<br>`ENV_Siren#2:env_siren_02`<br>@0x7555 · uADPCM4Bit 48000/1ch · 4.835792s · loop · **decodable**<br>`ENV_Siren#0:env_siren_03`<br>@0x120 · uADPCM4Bit 48000/1ch · 0.491625s · loop · **decodable** |
| `ambience.sparks` | `AMB_Sparks` / `AMB_Sparks.dat` | `SparkSound` | `ENV_sparks#1:env_sparks_01`<br>@0x4d96 · uADPCM4Bit 48000/1ch · 1.258979s · one-shot · **decodable**<br>`ENV_sparks#2:env_sparks_02`<br>@0xc76f · uADPCM4Bit 48000/1ch · 0.63875s · one-shot · **decodable**<br>`ENV_sparks#3:env_sparks_03`<br>@0x10557 · uADPCM4Bit 48000/1ch · 1.055125s · one-shot · **decodable**<br>`ENV_sparks#4:env_sparks_04`<br>@0x16b77 · uADPCM4Bit 48000/1ch · 0.86375s · one-shot · **decodable**<br>`ENV_sparks#5:env_sparks_05`<br>@0x1bf07 · uADPCM4Bit 48000/1ch · 0.7175s · one-shot · **decodable**<br>`ENV_sparks#0:env_sparks_06`<br>@0x204 · uADPCM4Bit 48000/1ch · 0.780083s · one-shot · **decodable** |
| `ambience.train_subway` | `AMB_Train_Subway` / `AMB_Train_Subway.dat` | `TrainSubwaySound` | `ENV_train_subway#0:env_train_subway`<br>@0x88 · uADPCM4Bit 48000/1ch · 91.591396s · loop · **decodable** |
| `ambience.vehicle_car` | `AMB_Vehicle_car` / `AMB_Vehicle_car.dat` | `car_loop` | `ENV_vehicle_car#0:env_vehicle_car`<br>@0x88 · uADPCM4Bit 48000/1ch · 1.770312s · loop · **decodable** |
| `ambience.vehicle_lorry` | `AMB_Vehicle_lorry` / `AMB_Vehicle_lorry.dat` | `lorry_loop01` | `ENV_vehicle_lorry#0:env_vehicle_lorry`<br>@0x88 · uADPCM4Bit 48000/1ch · 1.760375s · loop · **decodable** |
| `ambience.vehicle_plane_prop` | `AMB_Vehicle_plane_prop` / `AMB_Vehicle_plane_prop.dat` | `plane_loop01` | `ENV_vehicle_plane_prop#0:env_vehicle_plane_prop`<br>@0x88 · uADPCM4Bit 48000/1ch · 3.740604s · loop · **decodable** |
| `ambience.vehicle_train` | `AMB_Vehicle_train` / `AMB_Vehicle_train.dat` | `train_loop01` | `ENV_vehicle_train#0:env_vehicle_train`<br>@0x88 · uADPCM4Bit 48000/1ch · 3.652375s · loop · **decodable** |
| `ambience.vehicle_tram` | `AMB_Vehicle_tram` / `AMB_Vehicle_tram.dat` | `tram_loop01` | `ENV_vehicle_tram#0:env_vehicle_tram`<br>@0x88 · uADPCM4Bit 48000/1ch · 2.495521s · loop · **decodable** |

## 6. Gain, pitch and loop data

The retail sound components expose four options, resolved by
`Component::GetLevel` / `GetFrequency`:

```text
effective linear gain = optLevel (linear) * 10^(optGain_dB / 20)   (gain != 0 dB)
effective rate        = optFrequency (linear) * 2^optPitch (octaves)
```

An option is **literal** when its `Control.sCom == -1`; otherwise it is driven
by another component, and the catalog records the control component and, when
it is a piecewise-linear curve, its points. UI one-shots are literal: their
decoded `gain` values are shown below. Loops are mostly control-driven, so their
gain/rate are marked `provisional` in the contract; the decoded curves are in
`audio-catalog.json` and are listed in §6.2.

### 6.1 Literal UI gains

| Event | Wave | Level (linear) | Gain (dB) | Effective linear |
| --- | --- | ---: | ---: | ---: |
| `ui.apply_bossmod` | `FE_ApplyBossMod` | 1.0 | 5.0 | **1.778279** |
| `ui.boss_demand.complete` | `FE_BossDemandComplete` | 1.0 | 2.0 | **1.258925** |
| `ui.boss_demand.increment` | `FE_BossDemandIncrement` | 1.0 | 0.0 | **1.000000** |
| `ui.carousel.left_right` | `FE_Carousel_LR` | 1.0 | 0.0 | **1.000000** |
| `ui.cascade` | `FE_Cascade` | 1.0 | 0.0 | **1.000000** |
| `ui.challenge.new_item` | `FE_ChallengeNewItem` | 1.0 | 0.0 | **1.000000** |
| `ui.confirm` | `FE_Forward` | 1.0 | 0.0 | **1.000000** |
| `ui.error` | `FE_Error` | 1.0 | 4.0 | **1.584893** |
| `ui.filter` | `FE_Filter` | 1.0 | -2.0 | **0.794328** |
| `ui.friend.tale_of_the_tape` | `FE_FriendTaleOfTheTape` | 1.0 | 6.0 | **1.995262** |
| `ui.friend.vs` | `FE_FriendVs` | 1.0 | 0.0 | **1.000000** |
| `ui.garage.colour_move` | `FE_GarageColourPickerMove` | 1.0 | -12.0 | **0.251189** |
| `ui.garage.exit` | `FE_GarageExit` | 1.0 | 0.0 | **1.000000** |
| `ui.garage.finish_style.01` | `FE_GarageFinishStyleSelect01` | 1.0 | -3.0 | **0.707946** |
| `ui.garage.finish_style.02` | `FE_GarageFinishStyleSelect02` | 1.0 | -3.0 | **0.707946** |
| `ui.garage.finish_style.03` | `FE_GarageFinishStyleSelect03` | 1.0 | -3.0 | **0.707946** |
| `ui.garage.finish_style.04` | `FE_GarageFinishStyleSelect04` | 1.0 | -3.0 | **0.707946** |
| `ui.garage.respray` | `FE_GarageReSpray` | 1.0 | 5.0 | **1.778279** |
| `ui.garage.select` | `FE_GarageSelect` | 1.0 | -12.0 | **0.251189** |
| `ui.garage.select_vehicle` | `FE_GarageSelectVehicle` | 1.0 | 0.0 | **1.000000** |
| `ui.garage.switch_car` | `FE_GarageSwitchCar` | 1.0 | 0.0 | **1.000000** |
| `ui.graphic.backward` | `FE_GraphicBackward` | 1.0 | -2.0 | **0.794328** |
| `ui.graphic.forward` | `FE_GraphicForward` | 1.0 | -2.0 | **0.794328** |
| `ui.graphic.power` | `FE_GraphicPowerButton` | 1.0 | -9.0 | **0.354813** |
| `ui.lobby.countdown03` | `FE_LobbyCountDown03` | 1.0 | 0.0 | **1.000000** |
| `ui.lobby.countdown10` | `FE_LobbyCountDown10` | 1.0 | 0.0 | **1.000000** |
| `ui.lobby.join` | `FE_LobbyJoin` | 1.0 | 0.0 | **1.000000** |
| `ui.lobby.leave` | `FE_LobbyLeave` | 1.0 | 0.0 | **1.000000** |
| `ui.lobby.vote_count` | `FE_LobbyVoteCount` | 1.0 | 0.0 | **1.000000** |
| `ui.lrud` | `FE_LRUD` | 1.0 | 0.0 | **1.000000** |
| `ui.modshop.attach` | `FE_ModShopAttach` | 1.0 | 0.0 | **1.000000** |
| `ui.modshop.remove` | `FE_ModShopRemove` | 1.0 | 0.0 | **1.000000** |
| `ui.navigate.backward` | `FE_Backward` | 1.0 | 0.0 | **1.000000** |
| `ui.navigate.forward` | `FE_Forward` | 1.0 | -2.0 | **0.794328** |
| `ui.notice` | `FE_Notice` | 1.0 | 7.0 | **2.238721** |
| `ui.previously.out` | `FE_PrevOut` | 1.0 | 3.0 | **1.412538** |
| `ui.previously.reward` | `FE_PrevReward` | 1.0 | 0.0 | **1.000000** |
| `ui.previously.sparks` | `FE_PrevSparks` | 1.0 | 3.0 | **1.412538** |
| `ui.start` | `FE_Start` | 1.0 | 0.0 | **1.000000** |
| `ui.stickers.page` | `FE_StickersPage` | 1.0 | 3.0 | **1.412538** |
| `ui.tabs.close` | `FE_TabsClose` | 1.0 | 7.0 | **2.238721** |
| `ui.tabs.open` | `FE_TabsOpen` | 1.0 | 0.0 | **1.000000** |
| `ui.toggle` | `FE_Toggle` | 1.0 | -3.0 | **0.707946** |
| `ui.unlock_content` | `HUD_MPFinalScore` | 1.0 | 0.0 | **1.000000** |

44 UI variants have a literal gain. Zero dB is unity; negative values
are retail attenuation, not a harness choice.

### 6.2 Control-linked curves on decoded event sounds

| Event | Option | Control component | Points (x,y) |
| --- | --- | --- | --- |
| `race.perks.countdown` | frequency | `PerkCounterPitch` | (0,0.6), (1,0.8), (2,1) |
| `race.fans.gate_pass` | frequency | `FanGateCounterPitch` | (0,0.6), (1,0.7), (2,0.8), (3,0.9), (4,1), (5,1.1), (6,1.2), (7,1.3), (8,1.4), (9,1.5), (10,1.6), (11,1.7) |
| `race.wreck` | level | `WreckedModVolume` | (0,1), (1.3,1), (2,0) |
| `powerup.mine.arm` | frequency | `BombActiveFrequencyModifier` | (0,0.5), (60,2) |
| `powerup.shield.loop` | frequency | `ShieldFrequencyWobble` | (0,1), (0.35,1.4), (0.5,0.8), (0.7,1) |
| `powerup.shield.activate.mod` | frequency | `ShieldFrequencyWobble` | (0,1), (0.35,1.4), (0.5,0.8), (0.7,1) |
| `engine.rpm.1500` | frequency | `Engine1Pitch` | (0,0), (0.299928,2) |
| `engine.rpm.1500` | level | `Engine1Volume` | (0.085,0), (0.12,1), (0.15,1), (0.225,0) |
| `engine.rpm.1995` | frequency | `Engine2Pitch` | (0,0), (0.3999,2) |
| `engine.rpm.1995` | level | `Engine2Volume` | (0.125,0), (0.193,1), (0.225,1), (0.3,0) |
| `engine.rpm.3015` | frequency | `Engine3Pitch` | (0,0), (0.60039,2) |
| `engine.rpm.3015` | level | `Engine3Volume` | (0.2,0), (0.268,1), (0.325,1), (0.4,0) |
| `engine.rpm.4005` | frequency | `Engine4Pitch` | (0,0), (0.79788,2) |
| `engine.rpm.4005` | level | `Engine4Volume` | (0.3,0), (0.368,1), (0.425,1), (0.5,0) |
| `engine.rpm.4995` | frequency | `Engine5Pitch` | (0,0), (1.00002,2) |
| `engine.rpm.4995` | level | `Engine5Volume` | (0.4,0), (0.468,1), (0.525,1), (0.6,0) |
| `engine.rpm.6000` | frequency | `Engine6Pitch` | (0,0), (1.20027,2) |
| `engine.rpm.6000` | level | `Engine6Volume` | (0.5,0), (0.568,1) |
| `collision.world.concrete` | gain | `CollisionVolume` | (0.8,-5), (50,3) |
| `collision.world.vegetation` | gain | `CollisionVolume` | (0.8,-5), (50,3) |
| `collision.world.wood` | gain | `CollisionVolume` | (0.8,-5), (50,3) |
| `collision.world.metal` | gain | `CollisionVolume` | (0.8,-5), (50,3) |
| `collision.world.glass` | gain | `CollisionVolume` | (0.8,-5), (50,3) |
| `collision.world.rubber` | gain | `CollisionVolume` | (0.8,-5), (50,3) |
| `collision.world.concrete_fence_chain` | gain | `CollisionVolume` | (0.8,-5), (50,3) |
| `collision.world.concrete_fence_plastic` | gain | `CollisionVolume` | (0.8,-5), (50,3) |
| `collision.world.metal_hollow` | gain | `CollisionVolume` | (0.8,-5), (50,3) |
| `collision.world.metal_armco` | gain | `CollisionVolume` | (0.8,-5), (50,3) |
| `collision.world.metal_fence_chain` | gain | `CollisionVolume` | (0.8,-5), (50,3) |
| `collision.world.metal_fence_solid` | gain | `CollisionVolume` | (0.8,-5), (50,3) |
| `collision.world.metal_fence_slatted` | gain | `CollisionVolume` | (0.8,-5), (50,3) |
| `collision.world.metal_solid_post` | gain | `CollisionVolume` | (0.8,-5), (50,3) |

Loop points: the BAF header carries a **loop flag**, not a start/end pair.
All decoded loops therefore use `loopStart = 0`, `loopEnd = samples`; the
manifest records both and the verifier checks them. The 66 ms ADPCM fade-in
is preserved at the loop seam; it is not repaired or crossfaded.

## 7. Decoded manifest

| Measure | Value |
| --- | ---: |
| Entries | **220** |
| Newly decoded | 160 |
| Reused existing | 60 |
| Loops / one-shots | 29 / 191 |
| Total bytes | **31,927,596 (30.4 MiB)** |
| New bytes | 24,145,406 (23.0 MiB) |
| Reused bytes | 7,782,190 (7.4 MiB) |
| Codecs | uADPCM4Bit 220 |
| Rates | 48000 Hz 220 |
| Channels | 1 ch 157, 2 ch 63 |

Per-category byte cost of the decoded event set (a wave shared by two events is
counted once per category that references it):

| Category | Entries | Bytes |
| --- | ---: | ---: |
| collision | 42 | 3,369,368 (3.2 MiB) |
| engine | 6 | 629,256 (614.5 KiB) |
| powerup | 49 | 7,166,648 (6.8 MiB) |
| race | 68 | 9,613,046 (9.2 MiB) |
| tyre | 12 | 3,783,566 (3.6 MiB) |
| ui | 43 | 7,365,712 (7.0 MiB) |

### 7.1 File hashes

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `_work/audio/audio-catalog.json` | 7,747,543 | `452a5c5f6c14e81389dee76f3a06545a1a49887be8180e445a6864207e539f33` |
| `_work/audio/audio-manifest.json` | 195,254 | `7d324e7a0694d6a89710c8d11da48d8d36df87bd46ea62d4334e4891f1974418` |
| `_work/audio/integration-contract.json` | 221,056 | `9b90985db1e8ef8613907c166f8d9a87f68ca2c4c6905d21cf36b26c00329257` |
| `_work/audio/audio-catalog-verify.json` | 1,570 | `9611b71839111d593579be343c76111f31d80d8937006178f5a559bb6ee4988e` |

Per-wave hashes are in `audio-manifest.json` and in the table below. The verifier
re-decodes every entry twice and requires both runs to be byte-identical to the
stored file, so these hashes are reproducible from the retail banks.

### 7.2 Full manifest table

| Wave UID | File | Offset | Bytes | SHA-256 | Loop | Duration | Source |
| --- | --- | ---: | ---: | --- | :---: | ---: | --- |
| `DO_concrete_fence_chain:0:imp_conchain03` | `_work/audio/imp_conchain03.wav` | 0x120 | 76,372 | `85217d8ed8f1f39774a71fe97bc0137d3aeaaa7c586f764de7161c621e0ebc7d` | — | 0.795083 s | existing-decoded |
| `DO_concrete_fence_chain:1:imp_conchain01` | `_work/audio/imp_conchain01.wav` | 0x4e1d | 77,836 | `70ba4b69508836b79b6f8dacac34753090183ed2f1daddc8c3d0ef797b0c9d98` | — | 0.810333 s | existing-decoded |
| `DO_concrete_fence_chain:2:imp_conchain02` | `_work/audio/imp_conchain02.wav` | 0x9c85 | 83,264 | `8215278426240191a9d66784c5c6a53213328bffc68f225ebc2f3cd64987ef3b` | — | 0.866875 s | existing-decoded |
| `DO_concrete_fence_plastic:0:imp_conplast01` | `_work/audio/imp_conplast01.wav` | 0x120 | 75,872 | `923014806e4e0fe7bb65e152e16c3cedbc7233ef1d06e6dd6ba79a4d85720ab4` | — | 0.789875 s | existing-decoded |
| `DO_concrete_fence_plastic:1:imp_conplast02` | `_work/audio/imp_conplast02.wav` | 0x4d99 | 76,908 | `062f8d735b6f28cf8cc0b624f5d6a85666518c59d23c09b86ee8702a28f4f8cb` | — | 0.800667 s | existing-decoded |
| `DO_concrete_fence_plastic:2:imp_conplast03` | `_work/audio/imp_conplast03.wav` | 0x9b1a | 64,240 | `17335bea239d1ba2f76da800dcc511235c6c30e783a8ed1ae1ebd28b84793848` | — | 0.668708 s | existing-decoded |
| `DO_concrete_large:0:imp_concl01` | `_work/audio/imp_concl01.wav` | 0x120 | 92,188 | `38c96aac56ab9fe83051f9474bd6b94a9da9b0247fe070df790401378c4b628d` | — | 0.959833 s | existing-decoded |
| `DO_concrete_large:1:imp_concl02` | `_work/audio/imp_concl02.wav` | 0x5df8 | 95,260 | `2902146e44837d07dff33b28710a4a884b5982338c7f0dcc25ef2784eb015b48` | — | 0.991833 s | existing-decoded |
| `DO_concrete_large:2:imp_concl03` | `_work/audio/imp_concl03.wav` | 0xbde8 | 95,716 | `5f9a96ca5df9b16aa129e0760d8eb483c7ef75eba13121ff9a0bf90d1b0ffce1` | — | 0.996583 s | existing-decoded |
| `DO_glass_hit:0:imp_glasshit01` | `_work/audio/imp_glasshit01.wav` | 0x120 | 58,730 | `3b2ed499d143c3c2480d2f1cdf2fb1d10a353051d5a66e71b40b6c7686b7f72b` | — | 0.611313 s | existing-decoded |
| `DO_glass_hit:1:imp_glasshit02` | `_work/audio/imp_glasshit02.wav` | 0x3c53 | 70,280 | `948e2fe3bd981620b4da6526682adae4ce9604ed41ad4fb1b521e27d28faef19` | — | 0.731625 s | existing-decoded |
| `DO_glass_hit:2:imp_glasshit03` | `_work/audio/imp_glasshit03.wav` | 0x8320 | 64,508 | `66f6539986d276a0b42b3611c687b12ad59e4bd709266ebdcbb2ffcffba0b6c9` | — | 0.6715 s | existing-decoded |
| `DO_metal_armco:0:imp_armco01` | `_work/audio/imp_armco01.wav` | 0x1b8 | 63,056 | `a16b0375d1792b2607f2f4c5d4825cff073dd39b5fecd6e3961640f4df412da6` | — | 0.656375 s | existing-decoded |
| `DO_metal_armco:1:imp_armco02` | `_work/audio/imp_armco02.wav` | 0x414d | 64,088 | `e8a76b54d85e4ad801fc2000c9a7d22de5d15b1b55f455ad61333e802d0716a5` | — | 0.667125 s | existing-decoded |
| `DO_metal_armco:2:imp_armco03` | `_work/audio/imp_armco03.wav` | 0x81ea | 59,312 | `74047a14c16357c63e64a6879ea98ba462801740e7b04fd53c687c609ba1883a` | — | 0.617375 s | existing-decoded |
| `DO_metal_fence_chainlink:0:imp_metal_fence_chainlink03` | `_work/audio/imp_metal_fence_chainlink03.wav` | 0x120 | 126,958 | `eb4850593edf6f81dd704537fe46e2cfe14ef00856e79bbf2f60ae0661a57f3f` | — | 1.322021 s | existing-decoded |
| `DO_metal_fence_chainlink:1:imp_metal_fence_chainlink01` | `_work/audio/imp_metal_fence_chainlink01.wav` | 0x8108 | 125,476 | `257d2f72bad39571b34bec78356388cc07bbf63e84de5f7449834de60812c162` | — | 1.306583 s | existing-decoded |
| `DO_metal_fence_chainlink:2:imp_metal_fence_chainlink02` | `_work/audio/imp_metal_fence_chainlink02.wav` | 0xff64 | 124,832 | `443abd04fcfbe27d97d453dc76f0e7073372f7300dc4f762997576b181e7ab6b` | — | 1.299875 s | existing-decoded |
| `DO_metal_hollow_large:0:imp_metholol01` | `_work/audio/imp_metholol01.wav` | 0x120 | 151,232 | `bc4a090aa23ae9db512dcac8d4c3844efa3ca02095d033c7fab348d54a253023` | — | 1.574875 s | existing-decoded |
| `DO_metal_hollow_large:1:imp_metholol02` | `_work/audio/imp_metholol02.wav` | 0x9986 | 147,916 | `1416298537526ecf447e80311a3cb33fe0c0eb7f06bf91a04f1ada05c1282fdd` | — | 1.540333 s | existing-decoded |
| `DO_metal_hollow_large:2:imp_metholol03` | `_work/audio/imp_metholol03.wav` | 0x12e92 | 157,780 | `489135be738286da98d9d32735f839dd6197539e4a3f818431fc5ef68df04939` | — | 1.643083 s | existing-decoded |
| `DO_metal_post_tall:0:imp_metpostt03` | `_work/audio/imp_metpostt03.wav` | 0x120 | 44,224 | `79fbf3da6d42ff44a7400666840810ed573c832abbb678e92d4275e0d17b8e19` | — | 0.460208 s | existing-decoded |
| `DO_metal_post_tall:1:imp_metpostt01` | `_work/audio/imp_metpostt01.wav` | 0x2dc2 | 45,454 | `8f809aea7b2cca3366987f63509a29c741c54795cf6ba926c7dfc3840fb94aa4` | — | 0.473021 s | existing-decoded |
| `DO_metal_post_tall:2:imp_metpostt02` | `_work/audio/imp_metpostt02.wav` | 0x5b8d | 44,560 | `734136188e63b0a389d0b361ebe0672e8159b760e67810323e4eb7348c9cb5e0` | — | 0.463708 s | existing-decoded |
| `DO_metal_railing:0:imp_metrailng03` | `_work/audio/imp_metrailng03.wav` | 0x120 | 80,920 | `89f060830b566bf78582f2a96cb13ee0b5e0e06c50f210466e0e50ea0b288689` | — | 0.842458 s | existing-decoded |
| `DO_metal_railing:1:imp_metrailng01` | `_work/audio/imp_metrailng01.wav` | 0x52a0 | 57,884 | `e72e2806329d5db481093768f32a9f5b7839f3f28de45273d35c7af90e0bea9e` | — | 0.6025 s | existing-decoded |
| `DO_metal_railing:2:imp_metrailng02` | `_work/audio/imp_metrailng02.wav` | 0x8cec | 61,150 | `9608fd189c7df48133172a6f71d0219095bb1b18d5d0359e78f8102a88709e34` | — | 0.636521 s | existing-decoded |
| `DO_metal_sheet:0:imp_metsheet01` | `_work/audio/imp_metsheet01.wav` | 0x120 | 79,322 | `e120a59363925cfe4cbc714359f0a9ab2a50d7b7ca952538154002efabb8ac29` | — | 0.825812 s | existing-decoded |
| `DO_metal_sheet:1:imp_metsheet02` | `_work/audio/imp_metsheet02.wav` | 0x5114 | 75,052 | `de7efe5c55342f2b93d807d1ce4c87043d4818067e9dd9a66f15080cdae5f407` | — | 0.781333 s | existing-decoded |
| `DO_metal_sheet:2:imp_metsheet03` | `_work/audio/imp_metsheet03.wav` | 0x9ca6 | 65,590 | `4d4384b18229064fce19dab31a4d247a999aa92094902e240b3d5728380eb12a` | — | 0.682771 s | existing-decoded |
| `DO_metal_solid_medium:0:imp_metalsolidm03` | `_work/audio/imp_metalsolidm03.wav` | 0x120 | 84,280 | `ac8ae86b17bcf3b9d9fef8fb25581447b605d38c1e10c4263ba47de368e2e4ec` | — | 0.877458 s | existing-decoded |
| `DO_metal_solid_medium:1:imp_metalsolidm01` | `_work/audio/imp_metalsolidm01.wav` | 0x561b | 77,698 | `c81f3b3d16839e10d6399d63a7ad1a73b875110aa11fb60888f4a07b6926ac2c` | — | 0.808896 s | existing-decoded |
| `DO_metal_solid_medium:2:imp_metalsolidm02` | `_work/audio/imp_metalsolidm02.wav` | 0xa462 | 78,134 | `dcae6dcb3ab42bb7ae7970326891c3506905267afd57f925e89d8bf249aea9f5` | — | 0.813438 s | existing-decoded |
| `DO_rubber_tyre:0:imp_tyre03` | `_work/audio/imp_tyre03.wav` | 0x120 | 32,092 | `7032c055beead6a3e36f7f6ba3f68b7bb316fb0a238b7ff29a850170563dcad5` | — | 0.333833 s | existing-decoded |
| `DO_rubber_tyre:1:imp_tyre01` | `_work/audio/imp_tyre01.wav` | 0x2183 | 27,776 | `658ec4cd079028339c0b612e3065e22696d20c7b95dc04db2849e908fba2220c` | — | 0.288875 s | existing-decoded |
| `DO_rubber_tyre:2:imp_tyre02` | `_work/audio/imp_tyre02.wav` | 0x3d84 | 29,160 | `6bb9a4a3a54afaa0b82ed00815f622edc46946580d5e5c062716ee37e7f0f61e` | — | 0.303292 s | existing-decoded |
| `DO_vegetation_hedge:0:imp_veghedge01` | `_work/audio/imp_veghedge01.wav` | 0x120 | 98,244 | `d84ff369e9a2e283771d5fdc7d2732f8fc60118c9724580727ebaa9d18bd2ead` | — | 1.022917 s | existing-decoded |
| `DO_vegetation_hedge:1:imp_veghedge02` | `_work/audio/imp_veghedge02.wav` | 0x6428 | 107,924 | `2d4248702f1a9037611248000245bca2af3318bc64e6a3dcb9d1fbfae9361a19` | — | 1.12375 s | existing-decoded |
| `DO_vegetation_hedge:2:imp_veghedge03` | `_work/audio/imp_veghedge03.wav` | 0xd0db | 96,336 | `9496951a844fe72ade7dacfbfbb098f2489f0563b374dfd654bba7bf7e44c28f` | — | 1.003042 s | existing-decoded |
| `DO_wood_fence:0:imp_wood_fence01` | `_work/audio/imp_wood_fence01.wav` | 0x120 | 70,976 | `ee41846a61d87ca8be7ea77475a45cf7cf184eaa952ce3c925cbe02510effc4c` | — | 0.738875 s | existing-decoded |
| `DO_wood_fence:1:imp_wood_fence02` | `_work/audio/imp_wood_fence02.wav` | 0x48b3 | 86,908 | `5282f83e6da91ae075b4cc3baa853f7dfe5f3528f9cc5651284444766c0b2c06` | — | 0.904833 s | existing-decoded |
| `DO_wood_fence:2:imp_wood_fence03` | `_work/audio/imp_wood_fence03.wav` | 0xa042 | 73,860 | `f655e29d4bc78c89e72f77e99ec2ea01fa6ee0f98a683ad8af0b7037c556ed0d` | — | 0.768917 s | existing-decoded |
| `FrontEndUI:0:FE_GraphicBackward` | `_work/audio/catalog/wav/FrontEndUI/FE_GraphicBackward.wav` | 0x1174 | 100,268 | `6ff4aebf953bf50a4a4517019ede56b77cd588bc262d5cf85ebb83dd3c9bde7b` | — | 0.522 s | decoded |
| `FrontEndUI:1:FE_Error` | `_work/audio/catalog/wav/FrontEndUI/FE_Error.wav` | 0x768c | 92,196 | `250245c322c52e19dff87389f2456d9ca5f1a6733090d6308c21b2135ac78603` | — | 0.479958 s | decoded |
| `FrontEndUI:2:FE_GarageReSpray` | `_work/audio/catalog/wav/FrontEndUI/FE_GarageReSpray.wav` | 0xd364 | 79,384 | `7978aee64e37864ab7cb24a0b0de439f53004d141ce50f44d4b6a80ab7b74d42` | — | 0.413229 s | decoded |
| `FrontEndUI:3:FE_Start` | `_work/audio/catalog/wav/FrontEndUI/FE_Start.wav` | 0x12358 | 176,184 | `3ca72053d9dfb0d759f506da948924e7d81e1e79d94b71a345cfcb16aae32571` | — | 0.917396 s | decoded |
| `FrontEndUI:4:FE_TabsOpen` | `_work/audio/catalog/wav/FrontEndUI/FE_TabsOpen.wav` | 0x1d502 | 113,872 | `989d944f24431d73e371c90d171d57914f67d5d042a00309349742e6d4ec9bf1` | — | 0.592854 s | decoded |
| `FrontEndUI:5:FE_GarageColourPickerMove` | `_work/audio/catalog/wav/FrontEndUI/FE_GarageColourPickerMove.wav` | 0x247c4 | 16,960 | `c3571649e5d0eced1316c8e7ac016fb5c64a3ca2ce81c4bea376480b8133e69b` | — | 0.088104 s | decoded |
| `FrontEndUI:6:FE_GarageExit` | `_work/audio/catalog/wav/FrontEndUI/FE_GarageExit.wav` | 0x25912 | 129,588 | `6200867571fa120a2892d4a8ebb054bf17f2dfd0a9228a293a2b2b299f09c4a0` | — | 0.674708 s | decoded |
| `FrontEndUI:10:FE_Toggle` | `_work/audio/catalog/wav/FrontEndUI/FE_Toggle.wav` | 0x3b604 | 44,804 | `aeeb38df29bf4a1d00d8bfbfc5bed50db9f78008c8ffa930960d529b6f78669c` | — | 0.233125 s | decoded |
| `FrontEndUI:11:FE_LobbyVoteCount` | `_work/audio/catalog/wav/FrontEndUI/FE_LobbyVoteCount.wav` | 0x3e32a | 40,656 | `009b9f69e76b5043027b4dd3e843c42bf30677b50f47705c5f66113971987692` | — | 0.211521 s | decoded |
| `FrontEndUI:12:FE_GarageFinishStyleSelect02` | `_work/audio/catalog/wav/FrontEndUI/FE_GarageFinishStyleSelect02.wav` | 0x40c30 | 96,044 | `dcfad08cec040d2d68cd63d127970fde39829b7728654c904338cf1bfb517960` | — | 0.5 s | decoded |
| `FrontEndUI:14:FE_ChallengeNewItem` | `_work/audio/catalog/wav/FrontEndUI/FE_ChallengeNewItem.wav` | 0x49d45 | 182,024 | `ad756a44a06d6966537b2c6110f41772813cb9b56bd5f205bfad78ded84e9553` | — | 0.947812 s | decoded |
| `FrontEndUI:16:FE_GarageFinishStyleSelect03` | `_work/audio/catalog/wav/FrontEndUI/FE_GarageFinishStyleSelect03.wav` | 0x5b551 | 96,196 | `a2d77a36284ce386528758866eb82e57dd9ec898f661f20a3fa3d55f4403c0a5` | — | 0.500792 s | decoded |
| `FrontEndUI:17:FE_LobbyCountDown03` | `_work/audio/catalog/wav/FrontEndUI/FE_LobbyCountDown03.wav` | 0x61649 | 70,144 | `706b5e03b8e57c4ee0a300768ee27df0afd1c15c0b71ed17e1b29921ae09a074` | — | 0.365104 s | decoded |
| `FrontEndUI:20:FE_GarageSelect` | `_work/audio/catalog/wav/FrontEndUI/FE_GarageSelect.wav` | 0x96485 | 115,992 | `192ae7a4245550807dd58ee2f67e76df1523dab82c4956d3ec1636b8124ed633` | — | 0.603896 s | decoded |
| `FrontEndUI:24:FE_LobbyLeave` | `_work/audio/catalog/wav/FrontEndUI/FE_LobbyLeave.wav` | 0xafb79 | 193,444 | `adf1f5eeed750479fc6c0be2f0d8092c0eed6eeb59e1776e0021f2623764dbcd` | — | 1.007292 s | decoded |
| `FrontEndUI:25:FE_LobbyJoin` | `_work/audio/catalog/wav/FrontEndUI/FE_LobbyJoin.wav` | 0xbbe69 | 190,432 | `ca4826780903273c54fa0eff860310285bc396d7ed6700358e7ca9cce81dc229` | — | 0.991604 s | decoded |
| `FrontEndUI:26:FE_ModShopRemove` | `_work/audio/catalog/wav/FrontEndUI/FE_ModShopRemove.wav` | 0xc7e41 | 215,084 | `f2858058d7bfa9fdaa3d8dd891dda6a9af3e9ee98557d74cf4925ebbf8f7559c` | — | 1.12 s | decoded |
| `FrontEndUI:28:FE_GarageSelectVehicle` | `_work/audio/catalog/wav/FrontEndUI/FE_GarageSelectVehicle.wav` | 0xdb78f | 419,884 | `d744aac9f9ce7b53ef3ada1baf98f68ac610bcabbe49cc5ac7ca89f0fd7955c5` | — | 2.186667 s | decoded |
| `FrontEndUI:29:FE_GarageFinishStyleSelect01` | `_work/audio/catalog/wav/FrontEndUI/FE_GarageFinishStyleSelect01.wav` | 0xf5e67 | 95,724 | `1185c16ed4c4d5ca491533d7a84cfa2a8543898b78bdc8f8aff84c471b594a0c` | — | 0.498333 s | decoded |
| `FrontEndUI:30:FE_ModShopAttach` | `_work/audio/catalog/wav/FrontEndUI/FE_ModShopAttach.wav` | 0xfbedb | 258,092 | `e34d8fefa7d3365c18ce7838841e69c605832cd7ec221480b9269ffc95ebf722` | — | 1.344 s | decoded |
| `FrontEndUI:31:FE_GarageSwitchCar` | `_work/audio/catalog/wav/FrontEndUI/FE_GarageSwitchCar.wav` | 0x10c2c3 | 252,040 | `9dc562e9e7bdcbbc8efdae09eb03a042a6dcecb55ad28529d75670caf7274b08` | — | 1.312479 s | decoded |
| `FrontEndUI:32:FE_LobbyCountDown10` | `_work/audio/catalog/wav/FrontEndUI/FE_LobbyCountDown10.wav` | 0x11c0bd | 42,836 | `7654d4b7d9d56d9668d6e7e2559e47026bdbc6d69b59458abae49342a6dcc786` | — | 0.222875 s | decoded |
| `FrontEndUI:34:FE_GarageFinishStyleSelect04` | `_work/audio/catalog/wav/FrontEndUI/FE_GarageFinishStyleSelect04.wav` | 0x12c639 | 96,084 | `60f1fa96ff9097b621d81ed3e236600ee9354c4aeb17683bfb19d58411ae344b` | — | 0.500208 s | decoded |
| `FrontEndUI:35:HUD_MPFinalScore` | `_work/audio/catalog/wav/FrontEndUI/HUD_MPFinalScore.wav` | 0x132731 | 293,428 | `6451aeb71d030c00c2c844c728dff49e38c8ce3004ec7042ae1080eee7f9e383` | — | 1.528042 s | decoded |
| `FrontEndUI:36:FE_PrevReward` | `_work/audio/catalog/wav/FrontEndUI/FE_PrevReward.wav` | 0x144eef | 511,904 | `965730b68262b6b2999507d1591031a7bc78692ee8c4a7484326efb7909ad9b8` | — | 2.665938 s | decoded |
| `FrontEndUI:37:FE_PrevOut` | `_work/audio/catalog/wav/FrontEndUI/FE_PrevOut.wav` | 0x165297 | 369,004 | `52e5c01e1805ee3ee663d8b1d562557c547edbf54d1d31a0358856ad2636fddf` | — | 1.921667 s | decoded |
| `FrontEndUI:38:FE_PrevSparks` | `_work/audio/catalog/wav/FrontEndUI/FE_PrevSparks.wav` | 0x17c663 | 274,368 | `97935ea1494427bac3007a3e577c665e272b0bc4a0f0f4a38c99e13a99b74d87` | — | 1.428771 s | decoded |
| `FrontEndUI:39:FE_StickersPage` | `_work/audio/catalog/wav/FrontEndUI/FE_StickersPage.wav` | 0x18dacb | 72,500 | `9abf1aa69b3207584184c762e151e95b47af49562d4274763c0afefda9141ee8` | — | 0.377375 s | decoded |
| `FrontEndUI:40:FE_TabsClose` | `_work/audio/catalog/wav/FrontEndUI/FE_TabsClose.wav` | 0x19240b | 79,488 | `bed2797f14dfa776ee5e69fd77a8c18c185b8ef9a392b6903b9ce776d97546db` | — | 0.413771 s | decoded |
| `FrontEndUI:41:FE_Carousel_LR` | `_work/audio/catalog/wav/FrontEndUI/FE_Carousel_LR.wav` | 0x197441 | 73,056 | `91e679fcff4b484f6f6983843b8afbe8554e948671ec51cc504869b3286e3a46` | — | 0.380271 s | decoded |
| `FrontEndUI:42:FE_Filter` | `_work/audio/catalog/wav/FrontEndUI/FE_Filter.wav` | 0x19be05 | 58,492 | `45846941005264156444bbb25adbf29b30b889a304b324a686548d3e93ae13a8` | — | 0.304417 s | decoded |
| `FrontEndUI:43:FE_LRUD` | `_work/audio/catalog/wav/FrontEndUI/FE_LRUD.wav` | 0x19f917 | 78,216 | `9c080d9b5e1672200666795a614bc7236e42a18007e75c9517a1b3576456ae5f` | — | 0.407146 s | decoded |
| `FrontEndUI:44:FE_ApplyBossMod` | `_work/audio/catalog/wav/FrontEndUI/FE_ApplyBossMod.wav` | 0x1a4803 | 198,128 | `377cec0604f35a421a81d9294ea515fe9132c49d00fad675f154acd83cb3468b` | — | 1.031688 s | decoded |
| `FrontEndUI:45:FE_BossDemandComplete` | `_work/audio/catalog/wav/FrontEndUI/FE_BossDemandComplete.wav` | 0x1b0f97 | 265,784 | `e37cf91da412c9c4dcfa6129ab81b9b50bd9b392bf5a2501f8743aaeef26d471` | — | 1.384062 s | decoded |
| `FrontEndUI:46:FE_BossDemandIncrement` | `_work/audio/catalog/wav/FrontEndUI/FE_BossDemandIncrement.wav` | 0x1c1b7d | 224,348 | `2ffce4cacb18891d5d46588ce52e1f31d4127a354c6d03189e3066d5330a4e24` | — | 1.16825 s | decoded |
| `FrontEndUI:48:FE_Cascade` | `_work/audio/catalog/wav/FrontEndUI/FE_Cascade.wav` | 0x1d5e55 | 134,332 | `1ce77d395a70332ee5fbd85fe9a4fdd48ea59dad3e91906ce319de97214d6fa6` | — | 0.699417 s | decoded |
| `FrontEndUI:50:FE_FriendVs` | `_work/audio/catalog/wav/FrontEndUI/FE_FriendVs.wav` | 0x1e466d | 610,876 | `d86f7af98b12ef7b23c45215d493f00afd0beb33d896d8a0034589464f1d1858` | — | 3.181417 s | decoded |
| `FrontEndUI:51:FE_FriendTaleOfTheTape` | `_work/audio/catalog/wav/FrontEndUI/FE_FriendTaleOfTheTape.wav` | 0x20addb | 481,244 | `3c9bdc3020be3f0a7995af247fe4d7349d4d0867343726a64a090a878fda81e7` | — | 2.50625 s | decoded |
| `FrontEndUI:52:FE_GraphicPowerButton` | `_work/audio/catalog/wav/FrontEndUI/FE_GraphicPowerButton.wav` | 0x229293 | 194,676 | `ce48856b8099efcaed354faeaa1356aefcb3e73fdae99306635cfd39cc376c4d` | — | 1.013708 s | decoded |
| `FrontEndUI:53:FE_Backward` | `_work/audio/catalog/wav/FrontEndUI/FE_Backward.wav` | 0x2356cd | 63,188 | `94369559ab80afeaf1c86a1703c2f423eff8b5be9ac3caee367a48c9965df142` | — | 0.328875 s | decoded |
| `FrontEndUI:54:FE_GraphicForward` | `_work/audio/catalog/wav/FrontEndUI/FE_GraphicForward.wav` | 0x239683 | 124,036 | `ac313f157afdebd6e4a4b011e06709b4ccc6b97582850bec090c566f62297ebb` | — | 0.645792 s | decoded |
| `FrontEndUI:55:FE_Forward` | `_work/audio/catalog/wav/FrontEndUI/FE_Forward.wav` | 0x241395 | 96,088 | `9bac90a6419011289843bedff7f172f0d64b42248fa79aecc5b6cd25352bc9a2` | — | 0.500229 s | decoded |
| `FrontEndUI:57:FE_Notice` | `_work/audio/catalog/wav/FrontEndUI/FE_Notice.wav` | 0x2487eb | 44,624 | `e5721f0663fcf0d785ef3c63a6138b4a666feca0f9d7f394d3c016ee566f6f60` | — | 0.232187 s | decoded |
| `InGameUI:0:HUD_MM5Points` | `_work/audio/catalog/wav/InGameUI/HUD_MM5Points.wav` | 0x1c70 | 183,008 | `aa18a38c2dab1306938d6ed2609eab09c16ea7e307a314400e25bf2db7f17e5f` | — | 0.952937 s | decoded |
| `InGameUI:1:HUD_MM1Point` | `_work/audio/catalog/wav/InGameUI/HUD_MM1Point.wav` | 0xd4ce | 145,512 | `4961d4158b1a042b8a7f07b98e1545a515a0adfdde873d298f6b757a33036fc3` | — | 0.757646 s | decoded |
| `InGameUI:2:HUD_MM2Points` | `_work/audio/catalog/wav/InGameUI/HUD_MM2Points.wav` | 0x16788 | 177,880 | `39089ba7350ed562f3182620169397aec12e91dc28dbaaf4527dd56233642514` | — | 0.926229 s | decoded |
| `InGameUI:3:HUD_FansTotalLarge` | `_work/audio/catalog/wav/InGameUI/HUD_FansTotalLarge.wav` | 0x21abe | 266,028 | `d92db55a97ac5fe554ca0ed060185ea583bdc0ea1311648159ba6a3cf55cb1fa` | — | 2.770667 s | decoded |
| `InGameUI:5:HUD_PerksCountdown` | `_work/audio/catalog/wav/InGameUI/HUD_PerksCountdown.wav` | 0x35703 | 58,270 | `3193b4c601aeeb568035f332df95b1d67d266b7e0da0aa8292d52956abf3ddcb` | — | 0.606521 s | decoded |
| `InGameUI:6:HUD_MPFocusOnWinner` | `_work/audio/catalog/wav/InGameUI/HUD_MPFocusOnWinner.wav` | 0x391b2 | 216,944 | `3979ba70d931510f90468b185ca38447b0c7bd5c78b286c94776879f70da7c27` | — | 1.129687 s | decoded |
| `InGameUI:7:HUD_MPPlayerFirst` | `_work/audio/catalog/wav/InGameUI/HUD_MPPlayerFirst.wav` | 0x46c5a | 506,328 | `ddee3e46fd25d3070893d4759f2814260dfe20cc55f799cafadd31f02b870eeb` | — | 2.636896 s | decoded |
| `InGameUI:12:HUD_RankCountUp` | `_work/audio/catalog/wav/InGameUI/HUD_RankCountUp.wav` | 0x6e29a | 4,844 | `875137cdf24585d0b11f112e7e4b32e5431b93a9f522d3815d2c3cc5e68cd020` | — | 0.05 s | decoded |
| `InGameUI:13:HUD_FansTotalSmall` | `_work/audio/catalog/wav/InGameUI/HUD_FansTotalSmall.wav` | 0x6e788 | 208,094 | `324ec534ebe83bb759c3f0d6c1c3df1691cc1f2e8d10d70402e95db508b43b97` | — | 2.167187 s | decoded |
| `InGameUI:15:HUD_MPFinishIn` | `_work/audio/catalog/wav/InGameUI/HUD_MPFinishIn.wav` | 0x7e989 | 281,920 | `155501ce6f37566b51a64f407fd911d6807f2fa93cb0dcb19bafa5d28ef78893` | — | 1.468104 s | decoded |
| `InGameUI:17:HUD_RaceEndCountDown10` | `_work/audio/catalog/wav/InGameUI/HUD_RaceEndCountDown10.wav` | 0x972a2 | 21,440 | `97b246f8a469fd01f983ee74716e137de8f4555d17d9e2f5bc8e7e18503a741e` | — | 0.222875 s | decoded |
| `InGameUI:18:HUD_MPNumberGlow` | `_work/audio/catalog/wav/InGameUI/HUD_MPNumberGlow.wav` | 0x98852 | 353,360 | `7e4df8db4d22149e2da58e23c315be120d05ca58ebcc403511b7a4a0f582ef16` | — | 1.840188 s | decoded |
| `InGameUI:19:HUD_FansCountUp` | `_work/audio/catalog/wav/InGameUI/HUD_FansCountUp.wav` | 0xaec64 | 9,622 | `ff8e62cef41ea98da92a8530b3392a99549e1f582d5449bf9760a23a0dbded3e` | — | 0.099771 s | decoded |
| `InGameUI:20:HUD_UnlockContent` | `_work/audio/catalog/wav/InGameUI/HUD_UnlockContent.wav` | 0xaf617 | 268,364 | `a617daf681490c4c43170abfdb594d63cdfe140c2f305e6da6975c001aa02a65` | — | 1.3975 s | decoded |
| `InGameUI:21:HUD_HealthLow` | `_work/audio/catalog/wav/InGameUI/HUD_HealthLow.wav` | 0xc0491 | 114,200 | `5ddf4e1e2bc388dc128b4ec9d6de574e4bc68a02e8972c658581c1f0fad5db7f` | — | 0.594562 s | decoded |
| `InGameUI:22:HUD_ModBeep3` | `_work/audio/catalog/wav/InGameUI/HUD_ModBeep3.wav` | 0xc7795 | 57,398 | `b70625c0a8c482259dc269617a979f254c610cf8648ba893a4055c04df264d58` | — | 0.597437 s | decoded |
| `InGameUI:23:HUD_FansTotalMedium` | `_work/audio/catalog/wav/InGameUI/HUD_FansTotalMedium.wav` | 0xcb17e | 237,504 | `33a5f10181366368caf3f69e5a35b2c41e0dc60193f6a1d90fd1b3b5d35b9881` | — | 2.473542 s | decoded |
| `InGameUI:24:HUD_MPFinalScore` | `_work/audio/catalog/wav/InGameUI/HUD_MPFinalScore.wav` | 0xda0c6 | 293,428 | `6451aeb71d030c00c2c844c728dff49e38c8ce3004ec7042ae1080eee7f9e383` | — | 1.528042 s | decoded |
| `InGameUI:27:HUD_ChainMultiplier` | `_work/audio/catalog/wav/InGameUI/HUD_ChainMultiplier.wav` | 0x108e12 | 17,442 | `caf959a398df91196f4cf7ac4563bb5fc1575d863be62038a73445bf2cc75a9a` | — | 0.181229 s | decoded |
| `InGameUI:28:HUD_RankUp` | `_work/audio/catalog/wav/InGameUI/HUD_RankUp.wav` | 0x109fa2 | 215,648 | `2984b09e49aaef4551cba60f11fc0acf20c49f294a5528f53c7ce25ffcd79ae7` | — | 1.122937 s | decoded |
| `InGameUI:29:HUD_LockHard` | `_work/audio/catalog/wav/InGameUI/HUD_LockHard.wav` | 0x117900 | 28,858 | `6e939fbeec37a83c693b7d2f9878cd2e7d2dcc78c8bed94aee2d1521ee7204ef` | — | 0.300146 s | decoded |
| `InGameUI:30:HUD_MPPositionIn` | `_work/audio/catalog/wav/InGameUI/HUD_MPPositionIn.wav` | 0x11962a | 118,528 | `f966f8619b40ad92631403f0c00ca52447450f52587e953cf64c42c420d9b397` | — | 0.617104 s | decoded |
| `InGameUI:31:HUD_ModBeep1` | `_work/audio/catalog/wav/InGameUI/HUD_ModBeep1.wav` | 0x120d90 | 41,832 | `582049bb701016e34bf9dc552eb3657c55feb5e8038af8e693e79a0e0176465d` | — | 0.435292 s | decoded |
| `InGameUI:32:HUD_MPRankAway` | `_work/audio/catalog/wav/InGameUI/HUD_MPRankAway.wav` | 0x1237bf | 185,140 | `2e3c340db6ae94ed3750e010cfd50df3532543052b0c38130a869792772a0baa` | — | 0.964042 s | decoded |
| `InGameUI:33:HUD_ChallengeComplete` | `_work/audio/catalog/wav/InGameUI/HUD_ChallengeComplete.wav` | 0x12f26f | 199,052 | `c29366c13ada9945aa27c2667d762b0ebb4d0cb77bcebebea7a8925bb3b3bdec` | — | 1.0365 s | decoded |
| `InGameUI:34:HUD_LockSoft` | `_work/audio/catalog/wav/InGameUI/HUD_LockSoft.wav` | 0x13bb0b | 7,004 | `13e4eea425ed26bb9ac1f5d3c59bcccad1ada91feb74ea89d133ac1910734e80` | — | 0.0725 s | decoded |
| `InGameUI:35:HUD_Wrecked` | `_work/audio/catalog/wav/InGameUI/HUD_Wrecked.wav` | 0x13c22a | 866,080 | `ebe36bd51cde62bc8c1bc381077ac748809742caed774aa942702de2d8d6ba27` | — | 4.510604 s | decoded |
| `InGameUI:36:HUD_PerksGo` | `_work/audio/catalog/wav/InGameUI/HUD_PerksGo.wav` | 0x172a60 | 92,204 | `4382a921940d6d952a5400f312b6cce7b8695b4f68797ad2865f10a1c0b6a66a` | — | 0.96 s | decoded |
| `InGameUI:37:HUD_MotorMashCount` | `_work/audio/catalog/wav/InGameUI/HUD_MotorMashCount.wav` | 0x178738 | 20,312 | `41e60787d90248e68c876bb2875681ab97c1ea65d3d5760fb0093ac1b2c65bbd` | — | 0.211125 s | decoded |
| `InGameUI:39:MOD_IronFist` | `_work/audio/catalog/wav/InGameUI/MOD_IronFist.wav` | 0x17d6f2 | 96,606 | `5be2e58eb1da08e3b762b669b964fd042da31dffa12abd46d0400bffee6c318f` | — | 1.005854 s | decoded |
| `InGameUI:40:HUD_CountDown03` | `_work/audio/catalog/wav/InGameUI/HUD_CountDown03.wav` | 0x18384d | 35,094 | `4e1b71381f64d067a3c47d7d7e6dd5c12da0cff2f67a709c919256786d7511de` | — | 0.365104 s | decoded |
| `InGameUI:41:HUD_Fans` | `_work/audio/catalog/wav/InGameUI/HUD_Fans.wav` | 0x185ba7 | 32,586 | `633e8f9fe8ab9ddbdc8f999546c941c7cdb89ad9958f5a9c95268876f956c32b` | — | 0.338979 s | decoded |
| `InGameUI:42:HUD_DiscardPickup` | `_work/audio/catalog/wav/InGameUI/HUD_DiscardPickup.wav` | 0x187c8e | 34,792 | `2c11a73c2d131f2e9de46e9baa9ba00d32eaff62471f9c3f9251bc1cb23aa99d` | — | 0.361958 s | decoded |
| `InGameUI:43:HUD_RaceStart` | `_work/audio/catalog/wav/InGameUI/HUD_RaceStart.wav` | 0x189fa6 | 303,082 | `955655992d9a7fe8a2fe936422215ba48a923b16f6cb054dd1776c969bcd841a` | — | 3.156646 s | decoded |
| `InGameUI:44:HUD_RaceStartCountdown` | `_work/audio/catalog/wav/InGameUI/HUD_RaceStartCountdown.wav` | 0x19d0ee | 99,892 | `aa1e030e4a9080ca1f6489569d2e7278a3c76ed68712aadd9ccb6a87491f533d` | — | 1.040083 s | decoded |
| `InGameUI:45:HUD_RaceStartLFE` | `_work/audio/catalog/wav/InGameUI/HUD_RaceStartLFE.wav` | 0x1a35a3 | 163,014 | `b6baa07415f42d4cdf2e5cdc05ef3330353ae790c2081d4f97b6e4bac2187d9e` | — | 1.697604 s | decoded |
| `InGameUI:46:HUD_RaceStartCountdownLFE` | `_work/audio/catalog/wav/InGameUI/HUD_RaceStartCountdownLFE.wav` | 0x1ad9e5 | 29,372 | `dcbc46aa7f88b4f1d29640b9d5c3818a019b44cf92923f695397fcc4282680e3` | — | 0.3055 s | decoded |
| `InGameUI:47:HUD_WreckedLFE` | `_work/audio/catalog/wav/InGameUI/HUD_WreckedLFE.wav` | 0x1af793 | 346,234 | `348055600c252dd4b59c1be989081f5368a84f1b7f690418eea1b24637564d0b` | — | 3.606146 s | decoded |
| `InGameUI:48:HUD_MPFinishInLFE` | `_work/audio/catalog/wav/InGameUI/HUD_MPFinishInLFE.wav` | 0x1c544c | 192,044 | `e042025c43429de3afe0248cb4befcec9d5ea997e6969d001da894222d68684a` | — | 2.0 s | decoded |
| `InGameUI:49:HUD_ZoomWinnerLFE` | `_work/audio/catalog/wav/InGameUI/HUD_ZoomWinnerLFE.wav` | 0x1d15b0 | 79,128 | `10d8ebe39435af4f537be5994b985889039678f2c34cfba757cbfd72287553e0` | — | 0.823792 s | decoded |
| `InGameUI:50:HUD_PerkSwitch` | `_work/audio/catalog/wav/InGameUI/HUD_PerkSwitch.wav` | 0x1d6562 | 31,358 | `a59d7e5a9768611a9d0284ed93ec153115be5cdfef26cd9ddc35c0ad36fd58f9` | — | 0.326188 s | decoded |
| `InGameUI:51:HUD_DestructionWreckedLongShot` | `_work/audio/catalog/wav/InGameUI/HUD_DestructionWreckedLongShot.wav` | 0x1d84ff | 126,764 | `d523c481cd6a75ed4b1cfe5f6828519fc8f19614b5b899abbf97f6539e433164` | — | 1.32 s | decoded |
| `InGameUI:52:HUD_DestructionWrecked` | `_work/audio/catalog/wav/InGameUI/HUD_DestructionWrecked.wav` | 0x1e04a5 | 132,370 | `3627912d9374ed161cc44cacba514fcb6684799e3c7ab5ece0350845fbc6f334` | — | 1.378396 s | decoded |
| `InGameUI:53:HUD_FanDemandFail` | `_work/audio/catalog/wav/InGameUI/HUD_FanDemandFail.wav` | 0x1e89f7 | 144,102 | `daa6c25f3ff94959afeed4d38c44d9c3462eaf85c01ab2f105321d04acf54d5a` | — | 1.500604 s | decoded |
| `InGameUI:54:HUD_FanDemandSuccess` | `_work/audio/catalog/wav/InGameUI/HUD_FanDemandSuccess.wav` | 0x1f1b25 | 299,300 | `b7f5d33e5269d097d404ae81431abdcf139c36281e57083e0f155376e58979b2` | — | 3.11725 s | decoded |
| `InGameUI:55:HUD_GiftPowerUp` | `_work/audio/catalog/wav/InGameUI/HUD_GiftPowerUp.wav` | 0x20488f | 119,836 | `28d54dfaaa8d9cc1789cf57d4c6d1daa410d09ebd75be50cf4c29ea4af8bbb51` | — | 0.623917 s | decoded |
| `InGameUI:56:HUD_GiftHealth` | `_work/audio/catalog/wav/InGameUI/HUD_GiftHealth.wav` | 0x20c13f | 131,484 | `ee99843112baabdbe989e0da094a04d123cdda2a01de9c5de9cadbaca7df9877` | — | 0.684583 s | decoded |
| `InGameUI:57:HUD_PickupsFireError` | `_work/audio/catalog/wav/InGameUI/HUD_PickupsFireError.wav` | 0x2145cb | 44,992 | `0d2785260f4966e8c8f4da107a66a3057631f4a52c79fe34a0b277096522e246` | — | 0.468208 s | decoded |
| `InGameUI:58:HUD_StartLinePass` | `_work/audio/catalog/wav/InGameUI/HUD_StartLinePass.wav` | 0x217333 | 48,044 | `bc64294636ab65c619d4890a77a57eaed98cb4b002ee20dee1dfd3c1e62d2bab` | — | 0.25 s | decoded |
| `InGameUI:59:HUD_CheckPass` | `_work/audio/catalog/wav/InGameUI/HUD_CheckPass.wav` | 0x21a3b3 | 482,768 | `aac10299ffa339c2c25f426eaffb9971f0f3a4c9fbf4a4b6d685056e759dc4cd` | — | 2.514187 s | decoded |
| `InGameUI:60:HUD_LockHardECM` | `_work/audio/catalog/wav/InGameUI/HUD_LockHardECM.wav` | 0x2389f7 | 35,732 | `e1dc648b781fc14deb7e5d306d2072ca32a42bf291f49c0507069e931158cb62` | — | 0.37175 s | decoded |
| `InGameUI:61:HUD_FanGatePassBeep` | `_work/audio/catalog/wav/InGameUI/HUD_FanGatePassBeep.wav` | 0x23adf6 | 110,836 | `f115b51b480a24f9fe0b1bd1e58c23cc72a94c113168f10dc4fa42e797cfc367` | — | 1.154083 s | decoded |
| `InGameUI:66:MOD_ScramblerDeactivate` | `_work/audio/catalog/wav/InGameUI/MOD_ScramblerDeactivate.wav` | 0x256c64 | 113,772 | `03473f07e899eb56bb6a8e3f35d44503f3c4f3172d7740483cd8229606940058` | — | 1.184667 s | decoded |
| `InGameUI:67:MOD_ScramblerActivate` | `_work/audio/catalog/wav/InGameUI/MOD_ScramblerActivate.wav` | 0x25df05 | 139,020 | `33e4b654494dd122016934d497a08543d98b57edaf6b58bbc6ea5cfa1f42e101` | — | 1.447667 s | decoded |
| `InGameUI:68:HUD_LightAward` | `_work/audio/catalog/wav/InGameUI/HUD_LightAward.wav` | 0x266b0b | 41,476 | `6a1185f668f9d8816492906df8243e1a2db60bdd9111808de623a8c5bdc1d5db` | — | 0.431583 s | decoded |
| `InGameUI:69:HUD_DropLightStatus` | `_work/audio/catalog/wav/InGameUI/HUD_DropLightStatus.wav` | 0x2694d7 | 90,814 | `80affed3030197a46a18add6b231a6d6ef5cff251ac8b77550d63d502c7a04cd` | — | 0.945521 s | decoded |
| `InGameUI:70:HUD_Stopwatch` | `_work/audio/catalog/wav/InGameUI/HUD_Stopwatch.wav` | 0x26f065 | 78,442 | `5eba5ec1816f4010dbab1dd7532d5e998551beb5e6c41278a23d722851e88a73` | — | 0.816646 s | decoded |
| `InGameUI:71:HUD_PhotoTaken` | `_work/audio/catalog/wav/InGameUI/HUD_PhotoTaken.wav` | 0x273f72 | 135,580 | `c9d549049ccee8740e4d26921d8595cb1d01ee6214ca8589188c2e68977cf492` | — | 0.705917 s | decoded |
| `InGameUI:72:HUD_PostRaceGoalSpawn` | `_work/audio/catalog/wav/InGameUI/HUD_PostRaceGoalSpawn.wav` | 0x27c81e | 37,592 | `88d6521996fe54109e63f95a4f14b06e682e581ee2e105f97c8fb0cef3fdebb7` | — | 0.391125 s | decoded |
| `InGameUI:73:HUD_PostRaceLeaderboardSpawn` | `_work/audio/catalog/wav/InGameUI/HUD_PostRaceLeaderboardSpawn.wav` | 0x27ee0c | 63,390 | `9062dd5f133f096d6bbc638ea4fd5ed0be76cc7cee6f639a3c374010b6238875` | — | 0.659854 s | decoded |
| `InGameUI:74:HUD_PostRaceNewUnlocks` | `_work/audio/catalog/wav/InGameUI/HUD_PostRaceNewUnlocks.wav` | 0x282de3 | 63,390 | `9062dd5f133f096d6bbc638ea4fd5ed0be76cc7cee6f639a3c374010b6238875` | — | 0.659854 s | decoded |
| `InGameUI:75:HUD_PostRaceNotBest` | `_work/audio/catalog/wav/InGameUI/HUD_PostRaceNotBest.wav` | 0x286dba | 63,390 | `9062dd5f133f096d6bbc638ea4fd5ed0be76cc7cee6f639a3c374010b6238875` | — | 0.659854 s | decoded |
| `InGameUI:76:HUD_PostRacePassed` | `_work/audio/catalog/wav/InGameUI/HUD_PostRacePassed.wav` | 0x28ad91 | 176,702 | `5106208cec1fab9f0a157450e366602e5ee910e2fb703245abe3141fd3701d31` | — | 1.840188 s | decoded |
| `InGameUI:77:HUD_BossRaceLose` | `_work/audio/catalog/wav/InGameUI/HUD_BossRaceLose.wav` | 0x295f9e | 12,716 | `d63cdac39f68e7c2e671db7dc28a626792af432232d8e60613f264f5703e7b31` | — | 0.132 s | decoded |
| `InGameUI:78:HUD_BossRaceWin` | `_work/audio/catalog/wav/InGameUI/HUD_BossRaceWin.wav` | 0x296c69 | 12,716 | `d63cdac39f68e7c2e671db7dc28a626792af432232d8e60613f264f5703e7b31` | — | 0.132 s | decoded |
| `InGameUI:79:HUD_PostRaceBest` | `_work/audio/catalog/wav/InGameUI/HUD_PostRaceBest.wav` | 0x297934 | 63,390 | `9062dd5f133f096d6bbc638ea4fd5ed0be76cc7cee6f639a3c374010b6238875` | — | 0.659854 s | decoded |
| `InGameUI:80:HUD_PostRaceFailed` | `_work/audio/catalog/wav/InGameUI/HUD_PostRaceFailed.wav` | 0x29b90b | 63,390 | `9062dd5f133f096d6bbc638ea4fd5ed0be76cc7cee6f639a3c374010b6238875` | — | 0.659854 s | decoded |
| `InGameUI:81:HUD_PostRacePassedLightTrail` | `_work/audio/catalog/wav/InGameUI/HUD_PostRacePassedLightTrail.wav` | 0x29f8e2 | 141,592 | `4553251f4b7581712f7d578424d9c8831bd0202f954b67dad7695c0a8e287f24` | — | 1.474458 s | decoded |
| `Pickups:0:FanDemandPickup` | `_work/audio/catalog/wav/Pickups/FanDemandPickup.wav` | 0x146c | 120,924 | `bfe71dcce7d72335cf3ee37ddf8c10ea4576513a57e75741efb83d4ed64342da` | — | 1.259167 s | decoded |
| `Pickups:1:ShieldActivate` | `_work/audio/catalog/wav/Pickups/ShieldActivate.wav` | 0x8e45 | 191,644 | `6ee7ea1c1d330265080df858437f6167db1c8d6d98893be06958b940a465600f` | loop | 1.995833 s | decoded |
| `Pickups:2:ShockExplode` | `_work/audio/catalog/wav/Pickups/ShockExplode.wav` | 0x14f46 | 229,204 | `5d577293f455bcb5c85284e1ceaef567f35b2617f44b936a9dd23c339456b9aa` | — | 2.387083 s | decoded |
| `Pickups:3:ShockHitShield` | `_work/audio/catalog/wav/Pickups/ShockHitShield.wav` | 0x2362d | 119,874 | `9860c62cc6bfa6a55206111099e851bce7301ae12c16afb5b53094837249ed07` | — | 1.248229 s | decoded |
| `Pickups:4:ShockFire` | `_work/audio/catalog/wav/Pickups/ShockFire.wav` | 0x2aefe | 373,596 | `c5b66777408de6029b6f00860dbdc4527e8d90a5ca4d9b41ec5651136a406f90` | — | 3.891167 s | decoded |
| `Pickups:5:ShockHitCar` | `_work/audio/catalog/wav/Pickups/ShockHitCar.wav` | 0x4274d | 217,290 | `ba62ef5bfa955a63908ad7e25e0a9e1f768c0b9cab0bf5a92a24216d02e23df7` | — | 2.262979 s | decoded |
| `Pickups:6:NitroLFE` | `_work/audio/catalog/wav/Pickups/NitroLFE.wav` | 0x50237 | 94,810 | `a7e0ca1049c0bfce46fc8cc5e45d547866404af15bfbd689720120d970004b45` | loop | 0.987146 s | decoded |
| `Pickups:7:BlindFireActive` | `_work/audio/catalog/wav/Pickups/BlindFireActive.wav` | 0x561c4 | 169,968 | `9eaf07ce05620119f902ee2e5088e0f480268d999b54d2cb329184ce8765e359` | loop | 1.770042 s | decoded |
| `Pickups:9:MineHitCar` | `_work/audio/catalog/wav/Pickups/MineHitCar.wav` | 0x6521c | 105,644 | `617190df55f9685c0edcb0ed925a7638290c283ec76ca4a4fce150a284b99a3f` | — | 1.1 s | decoded |
| `Pickups:10:BargeFire` | `_work/audio/catalog/wav/Pickups/BargeFire.wav` | 0x6bc7d | 191,278 | `885830517e3c5f1c85478007dd63a09cbc76cb169042009b31a471120380fb64` | — | 1.992021 s | decoded |
| `Pickups:12:MineBackwardsFire` | `_work/audio/catalog/wav/Pickups/MineBackwardsFire.wav` | 0x7ad7a | 117,396 | `deb97dc8505f47fe41828af58e717477efbd979a6719774a26365e548b62cc49` | — | 1.222417 s | decoded |
| `Pickups:13:ShieldHit` | `_work/audio/catalog/wav/Pickups/ShieldHit.wav` | 0x823b7 | 67,328 | `15ebf41f1e066045b950e471b992242eec0dd9f023542df4da7cbae619d55036` | — | 0.700875 s | decoded |
| `Pickups:15:MineHitShield` | `_work/audio/catalog/wav/Pickups/MineHitShield.wav` | 0x928f1 | 99,832 | `b89709fa7ca1a79e7dbb7e8841c1d7901b451dbd602c70c56cb21b1ccfd5a954` | — | 1.039458 s | decoded |
| `Pickups:16:BargeHitShield` | `_work/audio/catalog/wav/Pickups/BargeHitShield.wav` | 0x98d85 | 92,708 | `bd8f07ba94ae14c8ae7bd89c7f1ea37cce5267492623e97a1b9aa6b46efe052c` | — | 0.96525 s | decoded |
| `Pickups:18:BlindFireHitCar` | `_work/audio/catalog/wav/Pickups/BlindFireHitCar.wav` | 0xa9973 | 50,120 | `763978131c3a8fb3af3c65c46d2113eb30de1b4d819af2e7220a6bd48bfada2e` | — | 0.521625 s | decoded |
| `Pickups:19:RepairActivate` | `_work/audio/catalog/wav/Pickups/RepairActivate.wav` | 0xacc03 | 147,106 | `c5bc8cd1e630a7c33653e2697150577485b5bf445bc2c0759382f6879835f205` | — | 1.531896 s | decoded |
| `Pickups:20:NitroBackwardFire` | `_work/audio/catalog/wav/Pickups/NitroBackwardFire.wav` | 0xb6028 | 91,168 | `ca7fc632a87a0d76def72b1548b4e3aa2355cbaeaa516d0ca26a8c244152b8e0` | — | 0.949208 s | decoded |
| `Pickups:21:MOD_ShieldActivate` | `_work/audio/catalog/wav/Pickups/MOD_ShieldActivate.wav` | 0xbbbf8 | 181,698 | `d085468044a9b8d7e1524ec7dfaa043ac9548f040a274fec7177591c76f0db3c` | loop | 1.892229 s | decoded |
| `Pickups:23:MineActive` | `_work/audio/catalog/wav/Pickups/MineActive.wav` | 0xce4c6 | 258,746 | `30834a0745562a76691e502ac989d04f98a16b00e709384feaa54ba0317359e6` | loop | 2.694812 s | decoded |
| `Pickups:25:ShuntHitShield` | `_work/audio/catalog/wav/Pickups/ShuntHitShield.wav` | 0xe2eb5 | 93,136 | `c36cc75c288d343a0fbde004cb39daa9909169fd03d91b9d74a2ee8c7dd3dd1d` | — | 0.969708 s | decoded |
| `Pickups:26:BlindFireHitShield` | `_work/audio/catalog/wav/Pickups/BlindFireHitShield.wav` | 0xe8c95 | 69,310 | `34946dcacc82737c703b6a092d0aa2dcedbd89e35921ed9980e695ce2d781d14` | — | 0.721521 s | decoded |
| `Pickups:27:BargeHitCar` | `_work/audio/catalog/wav/Pickups/BargeHitCar.wav` | 0xed27b | 167,192 | `2430c3dd1352d1aae3c547aad0b0499bb3aaeae87192e9c93be6308df268d9bf` | — | 1.741125 s | decoded |
| `Pickups:28:MineForwardsFire` | `_work/audio/catalog/wav/Pickups/MineForwardsFire.wav` | 0xf7add | 122,750 | `5d41b51c9b039b29bdc860f4623414f6871a68dba5df24cdf0d4eb7e859a2455` | — | 1.278188 s | decoded |
| `Pickups:29:ShuntHitWorld` | `_work/audio/catalog/wav/Pickups/ShuntHitWorld.wav` | 0xff684 | 56,906 | `0402550d7c78dccf6a8fe78c3466a8632fa2c79f0f6b2a932f4874406cd85892` | — | 0.592313 s | decoded |
| `Pickups:30:ShockFireLFE` | `_work/audio/catalog/wav/Pickups/ShockFireLFE.wav` | 0x102fe9 | 76,658 | `4be2294c290858eb328cd054868069cf9f456dd1690006f3a5e091ec4ebc5cf0` | — | 0.798063 s | decoded |
| `Pickups:31:MineExplodeLFE` | `_work/audio/catalog/wav/Pickups/MineExplodeLFE.wav` | 0x107d28 | 192,044 | `c040afe2eb28a6c1a0dfd0c3858891974119f03a58c544927ba599ea55243f0c` | — | 2.0 s | decoded |
| `Pickups:32:BlindFireFire` | `_work/audio/catalog/wav/Pickups/BlindFireFire.wav` | 0x113e8c | 89,912 | `6cb7f38e818b790d1389817a72a37f2352b99951d07cd3e820eeecc810c5197e` | — | 0.936125 s | decoded |
| `Pickups:33:PickupLoop` | `_work/audio/catalog/wav/Pickups/PickupLoop.wav` | 0x119933 | 278,850 | `7bca7685b7741ab7f05a4385434784b8f2b18066dffc41cf7c529bd5d8ed2205` | loop | 2.904229 s | decoded |
| `Pickups:35:Hit_LFE` | `_work/audio/catalog/wav/Pickups/Hit_LFE.wav` | 0x12ec49 | 19,244 | `7decb8d412607254910f0ce46103e76044b6faa7d8b0df2851637678a99ed0fe` | — | 0.2 s | decoded |
| `Pickups:37:NitroWhine` | `_work/audio/catalog/wav/Pickups/NitroWhine.wav` | 0x1314f4 | 194,392 | `867e35ac00cb177a35ff0d3a3795f4ce3b1dbf2d9b8753edbc80007c16b4b5d7` | loop | 2.024458 s | decoded |
| `Pickups:38:BlindFireHitWorld` | `_work/audio/catalog/wav/Pickups/BlindFireHitWorld.wav` | 0x13d8cb | 35,440 | `8e08c0be7a21881433d81101b5893ece1276d2cd0d4db2af5b5eab5827a25651` | — | 0.368708 s | decoded |
| `Pickups:39:ShuntHitCar` | `_work/audio/catalog/wav/Pickups/ShuntHitCar.wav` | 0x13fc88 | 206,014 | `1045a12bbaf1b580a290f9c3c3111a1fdac006b1465c352b52951caf57a799c0` | — | 2.145521 s | decoded |
| `Pickups:40:NitroFlameLoop` | `_work/audio/catalog/wav/Pickups/NitroFlameLoop.wav` | 0x14cc1a | 199,466 | `97acd240f106455344bb26f9a1536a6da8f68506010c524125935d19a1a90cb3` | loop | 2.077313 s | decoded |
| `Pickups:41:MOD_SplashDamageFire` | `_work/audio/catalog/wav/Pickups/MOD_SplashDamageFire.wav` | 0x1594f8 | 186,146 | `b7ba047e8c5ace4d9fcda92132c307331d4f2b3e744e1db90e230570fa4e71db` | — | 1.938562 s | decoded |
| `Pickups:42:MineExplode` | `_work/audio/catalog/wav/Pickups/MineExplode.wav` | 0x16506e | 214,780 | `12c7238dd85323d1bc5ba606e80350581140a2bc371bc8230983bc741ec4d08d` | — | 2.236833 s | decoded |
| `Pickups:43:ShuntHitPerk` | `_work/audio/catalog/wav/Pickups/ShuntHitPerk.wav` | 0x1728c4 | 195,862 | `e145007a245d47aae04675cb353df1cd737dee6653b9cca810b29b5ffcf63dfb` | — | 2.039771 s | decoded |
| `Pickups:44:PerkPickup` | `_work/audio/catalog/wav/Pickups/PerkPickup.wav` | 0x17ee06 | 47,856 | `550a2fe940d8317ebc663069a3392daad9a2b01c107f4286f9587f55d66b4fb9` | — | 0.498042 s | decoded |
| `Pickups:45:ShuntActive` | `_work/audio/catalog/wav/Pickups/ShuntActive.wav` | 0x181e44 | 229,258 | `bac479b2ce8edaf2b0c3302c5f56c796cd3a32d6363bf861f57372aae72ee2ec` | loop | 2.387646 s | decoded |
| `Pickups:46:ShuntFire` | `_work/audio/catalog/wav/Pickups/ShuntFire.wav` | 0x19052b | 217,788 | `b65497c725b676fcb82502d5a619d04f67ed5a2f60daab69a3a7b130fd7bb652` | — | 2.268167 s | decoded |
| `Pickups:47:ShuntCharge` | `_work/audio/catalog/wav/Pickups/ShuntCharge.wav` | 0x19e099 | 48,710 | `06ce54c0fa92728be2438670667b2cbb4735b6138b4b515f9d620dfc89138ca5` | — | 0.506938 s | decoded |
| `Pickups:48:NitroFire` | `_work/audio/catalog/wav/Pickups/NitroFire.wav` | 0x1a11be | 157,432 | `450540964cc99eaa1f4a2afccc19f3ee1e6b0ff1bdf12e696d7ca67bf40521cc` | — | 1.639458 s | decoded |
| `Pickups:49:NitroLowBoost` | `_work/audio/catalog/wav/Pickups/NitroLowBoost.wav` | 0x1ab054 | 199,726 | `032079d897f2e3cfa327295135e94f0d086a9681ddd147f72a561cf48f2a9903` | loop | 2.080021 s | decoded |
| `Pickups:51:ShieldHitStart` | `_work/audio/catalog/wav/Pickups/ShieldHitStart.wav` | 0x1bd0a0 | 83,412 | `2d6da56c6e244159fcd088c4a321aae28388500b2e55bc85b6c0705e4f338b0a` | — | 0.868417 s | decoded |
| `Pickups:52:ShieldHitStop` | `_work/audio/catalog/wav/Pickups/ShieldHitStop.wav` | 0x1c24b4 | 87,304 | `881346a6a9fb78977f7cb7814a1c8c371e23e35f5b609a380c7bd7854d96b6bd` | — | 0.908958 s | decoded |
| `Pickups:53:NitroHitCar` | `_work/audio/catalog/wav/Pickups/NitroHitCar.wav` | 0x1c7ca6 | 60,164 | `198e46aa617fade99d79008da3c8d79184ce534f39213f1fb92ec212ee76f698` | — | 0.62625 s | decoded |
| `Pickups:62:PickupDecoyLoop` | `_work/audio/catalog/wav/Pickups/PickupDecoyLoop.wav` | 0x20add1 | 261,844 | `03dbcc82e8a10aaa8b8a19cd919fe1af561b124734a0de13109d7d1875ecb610` | loop | 2.727083 s | decoded |
| `Pickups:63:BombMiniCreated` | `_work/audio/catalog/wav/Pickups/BombMiniCreated.wav` | 0x21b597 | 117,396 | `4c85c7f62788ded8110c20efab1c98f5959c318246522db8552118ea94168007` | — | 1.222417 s | decoded |
| `Pickups:64:BargeLastGasp` | `_work/audio/catalog/wav/Pickups/BargeLastGasp.wav` | 0x222bd4 | 227,272 | `c51eaaf18329ea2d94245f9ec069698ca4a21e144f24b0cdfb87024bdf03ce99` | — | 2.366958 s | decoded |
| `Pickups:65:NitroFireSweetener` | `_work/audio/catalog/wav/Pickups/NitroFireSweetener.wav` | 0x2310cc | 110,050 | `1a0f85d4923454b5aa7f07486a965567f6a629848164bf24cc6e9c9c315ecfb1` | — | 1.145896 s | decoded |
| `Race_V8:2:RaceV8_Engine_1500` | `_work/audio/RaceV8_Engine_1500.wav` | 0x18dd4 | 99,884 | `cc23b1f9b7338a99ff3c442b7bcbc03126f4829ede3c218965931345039723d0` | loop | 1.04 s | existing-decoded |
| `Race_V8:3:RaceV8_Engine_1995` | `_work/audio/RaceV8_Engine_1995.wav` | 0x1f268 | 103,724 | `82ba13b19ae3a5da92f4bbdb90aa9bd34c8f58eb169772787577a8f76f7315bf` | loop | 1.08 s | existing-decoded |
| `Race_V8:4:RaceV8_Engine_3015` | `_work/audio/RaceV8_Engine_3015.wav` | 0x25ada | 80,684 | `8c614ef2b96da7efc340d60c9b966fc153a579e6e5fa75c77b3bd72c2f27fb5a` | loop | 0.84 s | existing-decoded |
| `Race_V8:5:RaceV8_Engine_4005` | `_work/audio/RaceV8_Engine_4005.wav` | 0x2ac18 | 95,276 | `918b0be1ba3e625dafb054bc567a9eeb63d8e64c33a1d03a801b9c6a8da4d426` | loop | 0.992 s | existing-decoded |
| `Race_V8:6:RaceV8_Engine_4995` | `_work/audio/RaceV8_Engine_4995.wav` | 0x30c08 | 115,244 | `90dc40816f3eadef84270fa4cd6202b0c29e24227ec0aa7eb8c1eac921d64045` | loop | 1.2 s | existing-decoded |
| `Race_V8:7:RaceV8_Engine_6000` | `_work/audio/RaceV8_Engine_6000.wav` | 0x38014 | 134,444 | `34027924bcea28058e253731ed53576d69ea175671ce86a54730e9760996b983` | loop | 1.4 s | existing-decoded |
| `Wheel_dry:3:Asphalt_Lateral_1` | `_work/audio/Asphalt_Lateral_1.wav` | 0x325a6 | 294,956 | `394b5359078a6bf7cd22ae0c523fba313f97efdbca522a88b1c87406fd5cb669` | loop | 3.072 s | existing-decoded |
| `Wheel_dry:4:Asphalt_Lateral_2` | `_work/audio/Asphalt_Lateral_2.wav` | 0x44eae | 275,756 | `e2af185554671d43965bf812d5563d0ae219a1496ae50eda236002edce818e9e` | loop | 2.872 s | existing-decoded |
| `Wheel_dry:5:Asphalt_Lateral_3` | `_work/audio/Asphalt_Lateral_3.wav` | 0x56460 | 284,204 | `2ef515b278be1efa4f7ed71bece9f52e3ea1056f7663d4bb0b2bab997a845c31` | loop | 2.96 s | existing-decoded |
| `Wheel_dry:6:Asphalt_Road` | `_work/audio/Asphalt_Road.wav` | 0x68294 | 282,668 | `7a30f32053ad3e4e34f20bc2b4b139edee8bcb1f942bd6585e808a9de8b425e8` | loop | 2.944 s | existing-decoded |
| `Wheel_dry:7:Asphalt_Spin` | `_work/audio/Asphalt_Spin.wav` | 0x79f3c | 425,516 | `a3f8cbd11d5b1ecf01900d872694166b2820956758650a1329e6fb4856430518` | loop | 4.432 s | existing-decoded |
| `Wheel_offroad:4:Dirt_road` | `_work/audio/Dirt_road.wav` | 0x18af6 | 287,276 | `f84385da7f3e45559f52ce20efe9210717350144fa80d170114b98e118e583cd` | loop | 2.992 s | existing-decoded |
| `Wheel_offroad:5:Dirt_skid` | `_work/audio/Dirt_skid.wav` | 0x2ac42 | 371,756 | `4e5ba30cbfc505f6acbe2fee7bc5a1a447e8abcf090927ac176774e9521bab75` | loop | 3.872 s | existing-decoded |
| `Wheel_offroad:8:Foliage_road` | `_work/audio/Foliage_road.wav` | 0x60bc4 | 384,044 | `a58f85e1164eafaa8a114c7ee01d8ed4fcfad9fcb0abad33ef2be3892359313d` | loop | 4.0 s | existing-decoded |
| `Wheel_offroad:10:Gravel_road` | `_work/audio/Gravel_road.wav` | 0x8f7be | 335,660 | `996823a330b7cbcab34c2b11e21f8ae194f455b3d54f2f6b2c7005f90b19f117` | loop | 3.496 s | existing-decoded |
| `Wheel_offroad:11:Gravel_skid` | `_work/audio/Gravel_skid.wav` | 0xa49c4 | 284,972 | `ce2f823d3dab7d99c00c7a06e3aedde4e0d1dc8795dc3828e44afb1719e50b74` | loop | 2.968 s | existing-decoded |
| `Wheel_offroad:14:Sand_road` | `_work/audio/Sand_road.wav` | 0xd875f | 304,588 | `adfc937240c1183b15db3b6d4889c1bcc190a90a54512e17d9bc045418c74d5d` | loop | 3.172333 s | existing-decoded |
| `Wheel_offroad:15:Sand_skid` | `_work/audio/Sand_skid.wav` | 0xeba33 | 252,170 | `410718899b4fcac8c16576ffbfceba11935b511eeca6778c95c11d496933ce46` | loop | 2.626313 s | existing-decoded |

## 8. Integration contract for the web consumer

`_work/audio/integration-contract.json` is the machine-readable contract. It
contains one entry per decoded event:

```json
{
  "event": "ui.navigate.forward",
  "category": "ui", "entity": "FrontEndUI", "graph": "FrontEndUI.dat",
  "bus": "ui", "priority": 90, "duckGroup": "music", "priorityProvisional": true,
  "variants": [{
    "file": "_work/audio/catalog/wav/FrontEndUI/FE_Forward.wav",
    "sha256": "...", "bytes": 100268, "waveUid": "FrontEndUI:7:FE_Forward",
    "loop": false, "loopStart": 0, "loopEnd": null,
    "gainLinear": 0.794328, "gainDb": -2.0, "gainProvisional": false,
    "frequency": 1.0, "pitchOctaves": 0.0, "rate": 1.0, "rateProvisional": false,
    "bank": "FrontEndUI", "wave": "FE_Forward"
  }],
  "provenance": {"basis": "retail AudioEntityDef name + audio graph component name",
                  "entityRefId": 578343422, "graph": "FrontEndUI.dat"}
}
```

Rules:

1. Play only files whose SHA-256 matches the contract. If a file is missing or
   the hash differs, stay silent and report `fetch-failed`/`decode-failed`.
2. `gainLinear`/`gainDb` are retail-derived only when `gainProvisional:false`;
   otherwise apply `1.0` as a neutral placeholder and mark the value provisional
   in diagnostics. Do not invent a retail gain.
3. `rate` is `optFrequency * 2^optPitch`; when `rateProvisional:true`, use
   `1.0` and expose the decoded control curve if the page wants to drive it.
4. Loops start at `loopStart` and end at `loopEnd`. One-shots are not looped.
5. `priority` and `duckGroup` are **integration choices**, not decoded retail
   values; every group is marked `provisional:true`. A simple starting mix is:
   UI 90, race/HUD 80, power-up 70, collision 60, engine 50, tyre 40, music 20,
   ambience 10; UI/race duck music.
6. Unsupported events are listed under `unsupported` with a typed reason. The
   page must not substitute another wave.

### 8.1 Contract event table

| Event | File | Loop | Gain (linear) | Rate | Bus | Priority | Duck | Provisional |
| --- | --- | :---: | ---: | ---: | --- | ---: | --- | :---: |
| `collision.world.concrete` | `_work/audio/imp_concl01.wav` | no | — | 1.000000 | world | 60 | — | gain |
| `collision.world.concrete` | `_work/audio/imp_concl02.wav` | no | — | 1.000000 | world | 60 | — | gain |
| `collision.world.concrete` | `_work/audio/imp_concl03.wav` | no | — | 1.000000 | world | 60 | — | gain |
| `collision.world.concrete_fence_chain` | `_work/audio/imp_conchain01.wav` | no | — | 1.000000 | world | 60 | — | gain |
| `collision.world.concrete_fence_chain` | `_work/audio/imp_conchain02.wav` | no | — | 1.000000 | world | 60 | — | gain |
| `collision.world.concrete_fence_chain` | `_work/audio/imp_conchain03.wav` | no | — | 1.000000 | world | 60 | — | gain |
| `collision.world.concrete_fence_plastic` | `_work/audio/imp_conplast01.wav` | no | — | 1.000000 | world | 60 | — | gain |
| `collision.world.concrete_fence_plastic` | `_work/audio/imp_conplast02.wav` | no | — | 1.000000 | world | 60 | — | gain |
| `collision.world.concrete_fence_plastic` | `_work/audio/imp_conplast03.wav` | no | — | 1.000000 | world | 60 | — | gain |
| `collision.world.glass` | `_work/audio/imp_glasshit01.wav` | no | — | 1.000000 | world | 60 | — | gain |
| `collision.world.glass` | `_work/audio/imp_glasshit02.wav` | no | — | 1.000000 | world | 60 | — | gain |
| `collision.world.glass` | `_work/audio/imp_glasshit03.wav` | no | — | 1.000000 | world | 60 | — | gain |
| `collision.world.metal` | `_work/audio/imp_metsheet01.wav` | no | — | 1.000000 | world | 60 | — | gain |
| `collision.world.metal` | `_work/audio/imp_metsheet02.wav` | no | — | 1.000000 | world | 60 | — | gain |
| `collision.world.metal` | `_work/audio/imp_metsheet03.wav` | no | — | 1.000000 | world | 60 | — | gain |
| `collision.world.metal_armco` | `_work/audio/imp_armco01.wav` | no | — | 1.000000 | world | 60 | — | gain |
| `collision.world.metal_armco` | `_work/audio/imp_armco02.wav` | no | — | 1.000000 | world | 60 | — | gain |
| `collision.world.metal_armco` | `_work/audio/imp_armco03.wav` | no | — | 1.000000 | world | 60 | — | gain |
| `collision.world.metal_fence_chain` | `_work/audio/imp_metal_fence_chainlink01.wav` | no | — | 1.000000 | world | 60 | — | gain |
| `collision.world.metal_fence_chain` | `_work/audio/imp_metal_fence_chainlink02.wav` | no | — | 1.000000 | world | 60 | — | gain |
| `collision.world.metal_fence_chain` | `_work/audio/imp_metal_fence_chainlink03.wav` | no | — | 1.000000 | world | 60 | — | gain |
| `collision.world.metal_fence_slatted` | `_work/audio/imp_metrailng01.wav` | no | — | 1.000000 | world | 60 | — | gain |
| `collision.world.metal_fence_slatted` | `_work/audio/imp_metrailng02.wav` | no | — | 1.000000 | world | 60 | — | gain |
| `collision.world.metal_fence_slatted` | `_work/audio/imp_metrailng03.wav` | no | — | 1.000000 | world | 60 | — | gain |
| `collision.world.metal_fence_solid` | `_work/audio/imp_metalsolidm01.wav` | no | — | 1.000000 | world | 60 | — | gain |
| `collision.world.metal_fence_solid` | `_work/audio/imp_metalsolidm02.wav` | no | — | 1.000000 | world | 60 | — | gain |
| `collision.world.metal_fence_solid` | `_work/audio/imp_metalsolidm03.wav` | no | — | 1.000000 | world | 60 | — | gain |
| `collision.world.metal_hollow` | `_work/audio/imp_metholol01.wav` | no | — | 1.000000 | world | 60 | — | gain |
| `collision.world.metal_hollow` | `_work/audio/imp_metholol02.wav` | no | — | 1.000000 | world | 60 | — | gain |
| `collision.world.metal_hollow` | `_work/audio/imp_metholol03.wav` | no | — | 1.000000 | world | 60 | — | gain |
| `collision.world.metal_solid_post` | `_work/audio/imp_metpostt01.wav` | no | — | 1.000000 | world | 60 | — | gain |
| `collision.world.metal_solid_post` | `_work/audio/imp_metpostt02.wav` | no | — | 1.000000 | world | 60 | — | gain |
| `collision.world.metal_solid_post` | `_work/audio/imp_metpostt03.wav` | no | — | 1.000000 | world | 60 | — | gain |
| `collision.world.rubber` | `_work/audio/imp_tyre01.wav` | no | — | 1.000000 | world | 60 | — | gain |
| `collision.world.rubber` | `_work/audio/imp_tyre02.wav` | no | — | 1.000000 | world | 60 | — | gain |
| `collision.world.rubber` | `_work/audio/imp_tyre03.wav` | no | — | 1.000000 | world | 60 | — | gain |
| `collision.world.vegetation` | `_work/audio/imp_veghedge01.wav` | no | — | 1.000000 | world | 60 | — | gain |
| `collision.world.vegetation` | `_work/audio/imp_veghedge02.wav` | no | — | 1.000000 | world | 60 | — | gain |
| `collision.world.vegetation` | `_work/audio/imp_veghedge03.wav` | no | — | 1.000000 | world | 60 | — | gain |
| `collision.world.wood` | `_work/audio/imp_wood_fence01.wav` | no | — | 1.000000 | world | 60 | — | gain |
| `collision.world.wood` | `_work/audio/imp_wood_fence02.wav` | no | — | 1.000000 | world | 60 | — | gain |
| `collision.world.wood` | `_work/audio/imp_wood_fence03.wav` | no | — | 1.000000 | world | 60 | — | gain |
| `engine.rpm.1500` | `_work/audio/RaceV8_Engine_1500.wav` | yes | — | 1.000000 | vehicle | 50 | — | gain |
| `engine.rpm.1995` | `_work/audio/RaceV8_Engine_1995.wav` | yes | — | 1.000000 | vehicle | 50 | — | gain |
| `engine.rpm.3015` | `_work/audio/RaceV8_Engine_3015.wav` | yes | — | 1.000000 | vehicle | 50 | — | gain |
| `engine.rpm.4005` | `_work/audio/RaceV8_Engine_4005.wav` | yes | — | 1.000000 | vehicle | 50 | — | gain |
| `engine.rpm.4995` | `_work/audio/RaceV8_Engine_4995.wav` | yes | — | 1.000000 | vehicle | 50 | — | gain |
| `engine.rpm.6000` | `_work/audio/RaceV8_Engine_6000.wav` | yes | — | 1.000000 | vehicle | 50 | — | gain |
| `powerup.barge.activate` | `_work/audio/catalog/wav/Pickups/BargeFire.wav` | no | 1.000000 | 1.000000 | perks | 70 | — | rate |
| `powerup.barge.impact` | `_work/audio/catalog/wav/Pickups/BargeHitCar.wav` | no | 1.000000 | 1.000000 | perks | 70 | — | rate |
| `powerup.barge.impact.shield` | `_work/audio/catalog/wav/Pickups/BargeHitShield.wav` | no | 1.000000 | 1.000000 | perks | 70 | — | rate |
| `powerup.barge.last_gasp` | `_work/audio/catalog/wav/Pickups/BargeLastGasp.wav` | no | 1.000000 | 1.000000 | perks | 70 | — | rate |
| `powerup.bolt.activate` | `_work/audio/catalog/wav/Pickups/BlindFireFire.wav` | no | 1.000000 | 1.000000 | perks | 70 | — | rate |
| `powerup.bolt.impact` | `_work/audio/catalog/wav/Pickups/BlindFireHitCar.wav` | no | 1.000000 | 1.000000 | perks | 70 | — | rate |
| `powerup.bolt.impact.shield` | `_work/audio/catalog/wav/Pickups/BlindFireHitShield.wav` | no | 1.000000 | 1.000000 | perks | 70 | — | rate |
| `powerup.bolt.impact.world` | `_work/audio/catalog/wav/Pickups/BlindFireHitWorld.wav` | no | 1.000000 | 1.000000 | perks | 70 | — | rate |
| `powerup.bolt.projectile_loop` | `_work/audio/catalog/wav/Pickups/BlindFireActive.wav` | yes | 1.000000 | 1.000000 | perks | 70 | — | rate |
| `powerup.hit.lfe` | `_work/audio/catalog/wav/Pickups/Hit_LFE.wav` | no | 1.000000 | 1.000000 | perks | 70 | — | no |
| `powerup.mine.arm` | `_work/audio/catalog/wav/Pickups/MineActive.wav` | yes | — | 1.000000 | perks | 70 | — | gain |
| `powerup.mine.explode` | `_work/audio/catalog/wav/Pickups/MineExplode.wav` | no | 1.000000 | 1.000000 | perks | 70 | — | rate |
| `powerup.mine.explode.lfe` | `_work/audio/catalog/wav/Pickups/MineExplodeLFE.wav` | no | 1.000000 | 1.000000 | perks | 70 | — | no |
| `powerup.mine.impact` | `_work/audio/catalog/wav/Pickups/MineHitCar.wav` | no | 1.000000 | 1.000000 | perks | 70 | — | rate |
| `powerup.mine.impact.shield` | `_work/audio/catalog/wav/Pickups/MineHitShield.wav` | no | 1.000000 | 1.000000 | perks | 70 | — | rate |
| `powerup.mine.mini.created` | `_work/audio/catalog/wav/Pickups/BombMiniCreated.wav` | no | 1.000000 | 1.000000 | perks | 70 | — | rate |
| `powerup.mine.throw.backward` | `_work/audio/catalog/wav/Pickups/MineBackwardsFire.wav` | no | 1.000000 | 1.000000 | perks | 70 | — | rate |
| `powerup.mine.throw.forward` | `_work/audio/catalog/wav/Pickups/MineForwardsFire.wav` | no | 1.000000 | 1.000000 | perks | 70 | — | rate |
| `powerup.mod.splash_damage` | `_work/audio/catalog/wav/Pickups/MOD_SplashDamageFire.wav` | no | 1.000000 | 1.000000 | perks | 70 | — | rate |
| `powerup.nitro.activate` | `_work/audio/catalog/wav/Pickups/NitroFire.wav` | no | 1.000000 | 1.000000 | perks | 70 | — | rate |
| `powerup.nitro.activate` | `_work/audio/catalog/wav/Pickups/NitroFireSweetener.wav` | no | 1.000000 | 1.000000 | perks | 70 | — | rate |
| `powerup.nitro.activate` | `_work/audio/catalog/wav/Pickups/NitroBackwardFire.wav` | no | 1.000000 | 1.000000 | perks | 70 | — | rate |
| `powerup.nitro.impact` | `_work/audio/catalog/wav/Pickups/NitroHitCar.wav` | no | 1.000000 | 1.000000 | perks | 70 | — | rate |
| `powerup.nitro.loop.flame` | `_work/audio/catalog/wav/Pickups/NitroFlameLoop.wav` | yes | — | 1.000000 | perks | 70 | — | gain |
| `powerup.nitro.loop.lfe` | `_work/audio/catalog/wav/Pickups/NitroLFE.wav` | yes | 1.000000 | 1.000000 | perks | 70 | — | rate |
| `powerup.nitro.loop.low_boost` | `_work/audio/catalog/wav/Pickups/NitroLowBoost.wav` | yes | — | 1.000000 | perks | 70 | — | gain |
| `powerup.nitro.loop.whine` | `_work/audio/catalog/wav/Pickups/NitroWhine.wav` | yes | — | 1.000000 | perks | 70 | — | gain |
| `powerup.pickup` | `_work/audio/catalog/wav/Pickups/PerkPickup.wav` | no | 1.000000 | 1.000000 | perks | 70 | — | no |
| `powerup.pickup.decoy_loop` | `_work/audio/catalog/wav/Pickups/PickupDecoyLoop.wav` | yes | — | 1.000000 | perks | 70 | — | gain |
| `powerup.pickup.fan_demand` | `_work/audio/catalog/wav/Pickups/FanDemandPickup.wav` | no | 1.000000 | 1.000000 | perks | 70 | — | no |
| `powerup.pickup.loop` | `_work/audio/catalog/wav/Pickups/PickupLoop.wav` | yes | — | 1.000000 | perks | 70 | — | gain |
| `powerup.repair.activate` | `_work/audio/catalog/wav/Pickups/RepairActivate.wav` | no | 1.000000 | 1.000000 | perks | 70 | — | rate |
| `powerup.shield.activate.mod` | `_work/audio/catalog/wav/Pickups/MOD_ShieldActivate.wav` | yes | — | 1.000000 | perks | 70 | — | gain |
| `powerup.shield.hit` | `_work/audio/catalog/wav/Pickups/ShieldHit.wav` | no | 1.000000 | 1.000000 | perks | 70 | — | no |
| `powerup.shield.hit_start` | `_work/audio/catalog/wav/Pickups/ShieldHitStart.wav` | no | 1.000000 | 1.000000 | perks | 70 | — | rate |
| `powerup.shield.hit_stop` | `_work/audio/catalog/wav/Pickups/ShieldHitStop.wav` | no | 1.000000 | 1.000000 | perks | 70 | — | rate |
| `powerup.shield.loop` | `_work/audio/catalog/wav/Pickups/ShieldActivate.wav` | yes | — | 1.000000 | perks | 70 | — | gain |
| `powerup.shock.activate` | `_work/audio/catalog/wav/Pickups/ShockFire.wav` | no | 1.000000 | 1.000000 | perks | 70 | — | rate |
| `powerup.shock.activate.lfe` | `_work/audio/catalog/wav/Pickups/ShockFireLFE.wav` | no | 1.000000 | 1.000000 | perks | 70 | — | rate |
| `powerup.shock.explode` | `_work/audio/catalog/wav/Pickups/ShockExplode.wav` | no | 1.000000 | 1.000000 | perks | 70 | — | rate |
| `powerup.shock.impact` | `_work/audio/catalog/wav/Pickups/ShockHitCar.wav` | no | 1.000000 | 1.000000 | perks | 70 | — | rate |
| `powerup.shock.impact.shield` | `_work/audio/catalog/wav/Pickups/ShockHitShield.wav` | no | 1.000000 | 1.000000 | perks | 70 | — | rate |
| `powerup.shunt.activate` | `_work/audio/catalog/wav/Pickups/ShuntFire.wav` | no | 1.000000 | 1.000000 | perks | 70 | — | rate |
| `powerup.shunt.charge` | `_work/audio/catalog/wav/Pickups/ShuntCharge.wav` | no | 1.000000 | 1.000000 | perks | 70 | — | rate |
| `powerup.shunt.impact` | `_work/audio/catalog/wav/Pickups/ShuntHitCar.wav` | no | 1.000000 | 1.000000 | perks | 70 | — | rate |
| `powerup.shunt.impact.projectile` | `_work/audio/catalog/wav/Pickups/ShuntHitPerk.wav` | no | 1.000000 | 1.000000 | perks | 70 | — | rate |
| `powerup.shunt.impact.shield` | `_work/audio/catalog/wav/Pickups/ShuntHitShield.wav` | no | 1.000000 | 1.000000 | perks | 70 | — | rate |
| `powerup.shunt.impact.world` | `_work/audio/catalog/wav/Pickups/ShuntHitWorld.wav` | no | 1.000000 | 1.000000 | perks | 70 | — | rate |
| `powerup.shunt.projectile_loop` | `_work/audio/catalog/wav/Pickups/ShuntActive.wav` | yes | 1.000000 | 1.000000 | perks | 70 | — | rate |
| `race.award.light` | `_work/audio/catalog/wav/InGameUI/HUD_LightAward.wav` | no | 1.412538 | 1.000000 | hud | 80 | music | no |
| `race.boss.lose` | `_work/audio/catalog/wav/InGameUI/HUD_BossRaceLose.wav` | no | 2.818383 | 1.000000 | hud | 80 | music | no |
| `race.boss.win` | `_work/audio/catalog/wav/InGameUI/HUD_BossRaceWin.wav` | no | 2.818383 | 1.000000 | hud | 80 | music | no |
| `race.chain_multiplier` | `_work/audio/catalog/wav/InGameUI/HUD_ChainMultiplier.wav` | no | 1.258925 | 1.000000 | hud | 80 | music | no |
| `race.challenge.complete` | `_work/audio/catalog/wav/InGameUI/HUD_ChallengeComplete.wav` | no | 1.000000 | 1.000000 | hud | 80 | music | no |
| `race.countdown.long` | `_work/audio/catalog/wav/InGameUI/HUD_RaceEndCountDown10.wav` | no | 2.238721 | 1.000000 | hud | 80 | music | no |
| `race.countdown.short` | `_work/audio/catalog/wav/InGameUI/HUD_CountDown03.wav` | no | 3.162278 | 1.000000 | hud | 80 | music | no |
| `race.drop_light.status` | `_work/audio/catalog/wav/InGameUI/HUD_DropLightStatus.wav` | no | 1.412538 | 1.000000 | hud | 80 | music | no |
| `race.fans` | `_work/audio/catalog/wav/InGameUI/HUD_Fans.wav` | no | 0.398107 | 1.000000 | hud | 80 | music | no |
| `race.fans.count_up` | `_work/audio/catalog/wav/InGameUI/HUD_FansCountUp.wav` | no | 1.778279 | 1.000000 | hud | 80 | music | no |
| `race.fans.demand_fail` | `_work/audio/catalog/wav/InGameUI/HUD_FanDemandFail.wav` | no | 3.981072 | 1.000000 | hud | 80 | music | no |
| `race.fans.demand_success` | `_work/audio/catalog/wav/InGameUI/HUD_FanDemandSuccess.wav` | no | 2.238721 | 1.000000 | hud | 80 | music | no |
| `race.fans.gate_pass` | `_work/audio/catalog/wav/InGameUI/HUD_FanGatePassBeep.wav` | no | 1.584893 | 1.000000 | hud | 80 | music | rate |
| `race.fans.total_large` | `_work/audio/catalog/wav/InGameUI/HUD_FansTotalLarge.wav` | no | 1.000000 | 1.000000 | hud | 80 | music | no |
| `race.fans.total_medium` | `_work/audio/catalog/wav/InGameUI/HUD_FansTotalMedium.wav` | no | 1.000000 | 1.000000 | hud | 80 | music | no |
| `race.fans.total_small` | `_work/audio/catalog/wav/InGameUI/HUD_FansTotalSmall.wav` | no | 1.000000 | 1.000000 | hud | 80 | music | no |
| `race.finish.in` | `_work/audio/catalog/wav/InGameUI/HUD_MPFinishIn.wav` | no | 1.000000 | 1.000000 | hud | 80 | music | no |
| `race.finish.in.lfe` | `_work/audio/catalog/wav/InGameUI/HUD_MPFinishInLFE.wav` | no | 1.000000 | 1.000000 | hud | 80 | music | no |
| `race.gift.health` | `_work/audio/catalog/wav/InGameUI/HUD_GiftHealth.wav` | no | 2.238721 | 1.000000 | hud | 80 | music | no |
| `race.gift.powerup` | `_work/audio/catalog/wav/InGameUI/HUD_GiftPowerUp.wav` | no | 2.238721 | 1.000000 | hud | 80 | music | no |
| `race.health.low` | `_work/audio/catalog/wav/InGameUI/HUD_HealthLow.wav` | no | — | 1.000000 | hud | 80 | music | gain |
| `race.lap.pass` | `_work/audio/catalog/wav/InGameUI/HUD_CheckPass.wav` | no | 5.623413 | 1.000000 | hud | 80 | music | no |
| `race.lock.hard` | `_work/audio/catalog/wav/InGameUI/HUD_LockHard.wav` | no | 1.995262 | 1.000000 | hud | 80 | music | no |
| `race.lock.hard_ecm` | `_work/audio/catalog/wav/InGameUI/HUD_LockHardECM.wav` | no | 1.258925 | 1.000000 | hud | 80 | music | no |
| `race.lock.soft` | `_work/audio/catalog/wav/InGameUI/HUD_LockSoft.wav` | no | 1.412538 | 1.000000 | hud | 80 | music | no |
| `race.mod.iron_fist` | `_work/audio/catalog/wav/InGameUI/MOD_IronFist.wav` | no | 3.981072 | 1.000000 | hud | 80 | music | no |
| `race.mod.scrambler.activate` | `_work/audio/catalog/wav/InGameUI/MOD_ScramblerActivate.wav` | no | 1.995262 | 1.000000 | hud | 80 | music | no |
| `race.mod.scrambler.deactivate` | `_work/audio/catalog/wav/InGameUI/MOD_ScramblerDeactivate.wav` | no | 1.412538 | 1.000000 | hud | 80 | music | no |
| `race.mod.use.01` | `_work/audio/catalog/wav/InGameUI/HUD_ModBeep1.wav` | no | 1.412538 | 1.000000 | hud | 80 | music | no |
| `race.mod.use.02` | `_work/audio/catalog/wav/InGameUI/HUD_ModBeep3.wav` | no | 1.412538 | 1.000000 | hud | 80 | music | no |
| `race.mod.use.03` | `_work/audio/catalog/wav/InGameUI/HUD_ModBeep3.wav` | no | 1.412538 | 1.000000 | hud | 80 | music | no |
| `race.mode.mm.1point` | `_work/audio/catalog/wav/InGameUI/HUD_MM1Point.wav` | no | 3.981072 | 1.000000 | hud | 80 | music | no |
| `race.mode.mm.2points` | `_work/audio/catalog/wav/InGameUI/HUD_MM2Points.wav` | no | 3.981072 | 1.000000 | hud | 80 | music | no |
| `race.mode.mm.5points` | `_work/audio/catalog/wav/InGameUI/HUD_MM5Points.wav` | no | 3.981072 | 1.000000 | hud | 80 | music | no |
| `race.mode.mm.count` | `_work/audio/catalog/wav/InGameUI/HUD_MotorMashCount.wav` | no | 1.000000 | 1.000000 | hud | 80 | music | no |
| `race.mp.final_score` | `_work/audio/catalog/wav/InGameUI/HUD_MPFinalScore.wav` | no | 1.995262 | 1.000000 | hud | 80 | music | no |
| `race.mp.focus_winner` | `_work/audio/catalog/wav/InGameUI/HUD_MPFocusOnWinner.wav` | no | 3.981072 | 1.000000 | hud | 80 | music | no |
| `race.mp.number_glow` | `_work/audio/catalog/wav/InGameUI/HUD_MPNumberGlow.wav` | no | 2.238721 | 1.000000 | hud | 80 | music | no |
| `race.mp.rank_away` | `_work/audio/catalog/wav/InGameUI/HUD_MPRankAway.wav` | no | 1.995262 | 1.000000 | hud | 80 | music | no |
| `race.perk.switch` | `_work/audio/catalog/wav/InGameUI/HUD_PerkSwitch.wav` | no | 0.630957 | 1.000000 | hud | 80 | music | no |
| `race.perks.countdown` | `_work/audio/catalog/wav/InGameUI/HUD_PerksCountdown.wav` | no | 1.000000 | 1.000000 | hud | 80 | music | rate |
| `race.perks.go` | `_work/audio/catalog/wav/InGameUI/HUD_PerksGo.wav` | no | 2.818383 | 1.000000 | hud | 80 | music | no |
| `race.photo` | `_work/audio/catalog/wav/InGameUI/HUD_PhotoTaken.wav` | no | 2.818383 | 1.000000 | hud | 80 | music | no |
| `race.pickup.discard` | `_work/audio/catalog/wav/InGameUI/HUD_DiscardPickup.wav` | no | 5.623413 | 1.000000 | hud | 80 | music | no |
| `race.pickup.discard_decoy` | `_work/audio/catalog/wav/InGameUI/HUD_PickupsFireError.wav` | no | 3.548134 | 1.000000 | hud | 80 | music | no |
| `race.pickup.fire_error` | `_work/audio/catalog/wav/InGameUI/HUD_PickupsFireError.wav` | no | 0.562341 | 1.000000 | hud | 80 | music | no |
| `race.position.first` | `_work/audio/catalog/wav/InGameUI/HUD_MPPlayerFirst.wav` | no | 1.995262 | 1.000000 | hud | 80 | music | no |
| `race.position.first.lfe` | `_work/audio/catalog/wav/InGameUI/HUD_RaceStartCountdownLFE.wav` | no | 1.000000 | 1.000000 | hud | 80 | music | no |
| `race.position.in` | `_work/audio/catalog/wav/InGameUI/HUD_MPPositionIn.wav` | no | 1.995262 | 1.000000 | hud | 80 | music | no |
| `race.postrace.best` | `_work/audio/catalog/wav/InGameUI/HUD_PostRaceBest.wav` | no | 2.238721 | 1.000000 | hud | 80 | music | no |
| `race.postrace.failed` | `_work/audio/catalog/wav/InGameUI/HUD_PostRaceFailed.wav` | no | 2.238721 | 1.000000 | hud | 80 | music | no |
| `race.postrace.goal_spawn` | `_work/audio/catalog/wav/InGameUI/HUD_PostRaceGoalSpawn.wav` | no | 1.000000 | 1.000000 | hud | 80 | music | no |
| `race.postrace.leaderboard_spawn` | `_work/audio/catalog/wav/InGameUI/HUD_PostRaceLeaderboardSpawn.wav` | no | 2.238721 | 1.000000 | hud | 80 | music | no |
| `race.postrace.new_unlocks` | `_work/audio/catalog/wav/InGameUI/HUD_PostRaceNewUnlocks.wav` | no | 2.238721 | 1.000000 | hud | 80 | music | no |
| `race.postrace.not_best` | `_work/audio/catalog/wav/InGameUI/HUD_PostRaceNotBest.wav` | no | 2.238721 | 1.000000 | hud | 80 | music | no |
| `race.postrace.passed` | `_work/audio/catalog/wav/InGameUI/HUD_PostRacePassed.wav` | no | 3.981072 | 1.000000 | hud | 80 | music | no |
| `race.postrace.passed_light_trail` | `_work/audio/catalog/wav/InGameUI/HUD_PostRacePassedLightTrail.wav` | no | 5.011872 | 1.000000 | hud | 80 | music | no |
| `race.rank.count` | `_work/audio/catalog/wav/InGameUI/HUD_RankCountUp.wav` | no | 1.000000 | 1.000000 | hud | 80 | music | no |
| `race.rank.up` | `_work/audio/catalog/wav/InGameUI/HUD_RankUp.wav` | no | 1.412538 | 1.000000 | hud | 80 | music | no |
| `race.start` | `_work/audio/catalog/wav/InGameUI/HUD_RaceStart.wav` | no | 5.623413 | 1.000000 | hud | 80 | music | no |
| `race.start.countdown` | `_work/audio/catalog/wav/InGameUI/HUD_RaceStartCountdown.wav` | no | 3.981072 | 1.000000 | hud | 80 | music | no |
| `race.start.countdown.lfe` | `_work/audio/catalog/wav/InGameUI/HUD_RaceStartCountdownLFE.wav` | no | 1.000000 | 1.000000 | hud | 80 | music | no |
| `race.start.lfe` | `_work/audio/catalog/wav/InGameUI/HUD_RaceStartLFE.wav` | no | 1.000000 | 1.000000 | hud | 80 | music | no |
| `race.start_line.pass` | `_work/audio/catalog/wav/InGameUI/HUD_StartLinePass.wav` | no | 3.981072 | 1.000000 | hud | 80 | music | no |
| `race.stopwatch` | `_work/audio/catalog/wav/InGameUI/HUD_Stopwatch.wav` | no | 1.000000 | 1.000000 | hud | 80 | music | no |
| `race.unlock_content` | `_work/audio/catalog/wav/InGameUI/HUD_UnlockContent.wav` | no | 1.000000 | 1.000000 | hud | 80 | music | no |
| `race.wreck` | `_work/audio/catalog/wav/InGameUI/HUD_Wrecked.wav` | no | — | 1.000000 | hud | 80 | music | gain |
| `race.wreck.destruction` | `_work/audio/catalog/wav/InGameUI/HUD_DestructionWrecked.wav` | no | 2.818383 | 1.000000 | hud | 80 | music | no |
| `race.wreck.destruction.long` | `_work/audio/catalog/wav/InGameUI/HUD_DestructionWreckedLongShot.wav` | no | 2.818383 | 1.000000 | hud | 80 | music | no |
| `race.wreck.lfe` | `_work/audio/catalog/wav/InGameUI/HUD_WreckedLFE.wav` | no | 1.000000 | 1.000000 | hud | 80 | music | no |
| `race.zoom.winner.lfe` | `_work/audio/catalog/wav/InGameUI/HUD_ZoomWinnerLFE.wav` | no | 1.000000 | 1.000000 | hud | 80 | music | no |
| `tyre.dry.road` | `_work/audio/Asphalt_Road.wav` | yes | — | 1.000000 | vehicle | 40 | — | gain |
| `tyre.dry.skid0` | `_work/audio/Asphalt_Lateral_1.wav` | yes | — | 1.000000 | vehicle | 40 | — | gain |
| `tyre.dry.skid1` | `_work/audio/Asphalt_Lateral_2.wav` | yes | — | 1.000000 | vehicle | 40 | — | gain |
| `tyre.dry.skid2` | `_work/audio/Asphalt_Lateral_3.wav` | yes | — | 1.000000 | vehicle | 40 | — | gain |
| `tyre.dry.spin` | `_work/audio/Asphalt_Spin.wav` | yes | — | 1.000000 | vehicle | 40 | — | gain |
| `tyre.offroad.foliage.road` | `_work/audio/Foliage_road.wav` | yes | — | 1.000000 | vehicle | 40 | — | gain |
| `tyre.offroad.grass.road` | `_work/audio/Dirt_road.wav` | yes | — | 1.000000 | vehicle | 40 | — | gain |
| `tyre.offroad.grass.skid` | `_work/audio/Dirt_skid.wav` | yes | — | 1.000000 | vehicle | 40 | — | gain |
| `tyre.offroad.gravel.road` | `_work/audio/Gravel_road.wav` | yes | — | 1.000000 | vehicle | 40 | — | gain |
| `tyre.offroad.gravel.skid` | `_work/audio/Gravel_skid.wav` | yes | — | 1.000000 | vehicle | 40 | — | gain |
| `tyre.offroad.sand.road` | `_work/audio/Sand_road.wav` | yes | — | 1.000000 | vehicle | 40 | — | gain |
| `tyre.offroad.sand.skid` | `_work/audio/Sand_skid.wav` | yes | — | 1.000000 | vehicle | 40 | — | gain |
| `ui.apply_bossmod` | `_work/audio/catalog/wav/FrontEndUI/FE_ApplyBossMod.wav` | no | 1.778279 | 1.000000 | ui | 90 | music | no |
| `ui.boss_demand.complete` | `_work/audio/catalog/wav/FrontEndUI/FE_BossDemandComplete.wav` | no | 1.258925 | 1.000000 | ui | 90 | music | no |
| `ui.boss_demand.increment` | `_work/audio/catalog/wav/FrontEndUI/FE_BossDemandIncrement.wav` | no | 1.000000 | 1.000000 | ui | 90 | music | no |
| `ui.carousel.left_right` | `_work/audio/catalog/wav/FrontEndUI/FE_Carousel_LR.wav` | no | 1.000000 | 1.000000 | ui | 90 | music | no |
| `ui.cascade` | `_work/audio/catalog/wav/FrontEndUI/FE_Cascade.wav` | no | 1.000000 | 1.000000 | ui | 90 | music | no |
| `ui.challenge.new_item` | `_work/audio/catalog/wav/FrontEndUI/FE_ChallengeNewItem.wav` | no | 1.000000 | 1.000000 | ui | 90 | music | no |
| `ui.confirm` | `_work/audio/catalog/wav/FrontEndUI/FE_Forward.wav` | no | 1.000000 | 1.000000 | ui | 90 | music | no |
| `ui.error` | `_work/audio/catalog/wav/FrontEndUI/FE_Error.wav` | no | 1.584893 | 1.000000 | ui | 90 | music | no |
| `ui.filter` | `_work/audio/catalog/wav/FrontEndUI/FE_Filter.wav` | no | 0.794328 | 1.000000 | ui | 90 | music | no |
| `ui.friend.tale_of_the_tape` | `_work/audio/catalog/wav/FrontEndUI/FE_FriendTaleOfTheTape.wav` | no | 1.995262 | 1.000000 | ui | 90 | music | no |
| `ui.friend.vs` | `_work/audio/catalog/wav/FrontEndUI/FE_FriendVs.wav` | no | 1.000000 | 1.000000 | ui | 90 | music | no |
| `ui.garage.colour_move` | `_work/audio/catalog/wav/FrontEndUI/FE_GarageColourPickerMove.wav` | no | 0.251189 | 1.000000 | ui | 90 | music | no |
| `ui.garage.exit` | `_work/audio/catalog/wav/FrontEndUI/FE_GarageExit.wav` | no | 1.000000 | 1.000000 | ui | 90 | music | no |
| `ui.garage.finish_style.01` | `_work/audio/catalog/wav/FrontEndUI/FE_GarageFinishStyleSelect01.wav` | no | 0.707946 | 1.000000 | ui | 90 | music | no |
| `ui.garage.finish_style.02` | `_work/audio/catalog/wav/FrontEndUI/FE_GarageFinishStyleSelect02.wav` | no | 0.707946 | 1.000000 | ui | 90 | music | no |
| `ui.garage.finish_style.03` | `_work/audio/catalog/wav/FrontEndUI/FE_GarageFinishStyleSelect03.wav` | no | 0.707946 | 1.000000 | ui | 90 | music | no |
| `ui.garage.finish_style.04` | `_work/audio/catalog/wav/FrontEndUI/FE_GarageFinishStyleSelect04.wav` | no | 0.707946 | 1.000000 | ui | 90 | music | no |
| `ui.garage.respray` | `_work/audio/catalog/wav/FrontEndUI/FE_GarageReSpray.wav` | no | 1.778279 | 1.000000 | ui | 90 | music | no |
| `ui.garage.select` | `_work/audio/catalog/wav/FrontEndUI/FE_GarageSelect.wav` | no | 0.251189 | 1.000000 | ui | 90 | music | no |
| `ui.garage.select_vehicle` | `_work/audio/catalog/wav/FrontEndUI/FE_GarageSelectVehicle.wav` | no | 1.000000 | 1.000000 | ui | 90 | music | no |
| `ui.garage.switch_car` | `_work/audio/catalog/wav/FrontEndUI/FE_GarageSwitchCar.wav` | no | 1.000000 | 1.000000 | ui | 90 | music | no |
| `ui.graphic.backward` | `_work/audio/catalog/wav/FrontEndUI/FE_GraphicBackward.wav` | no | 0.794328 | 1.000000 | ui | 90 | music | no |
| `ui.graphic.forward` | `_work/audio/catalog/wav/FrontEndUI/FE_GraphicForward.wav` | no | 0.794328 | 1.000000 | ui | 90 | music | no |
| `ui.graphic.power` | `_work/audio/catalog/wav/FrontEndUI/FE_GraphicPowerButton.wav` | no | 0.354813 | 1.000000 | ui | 90 | music | no |
| `ui.lobby.countdown03` | `_work/audio/catalog/wav/FrontEndUI/FE_LobbyCountDown03.wav` | no | 1.000000 | 1.000000 | ui | 90 | music | no |
| `ui.lobby.countdown10` | `_work/audio/catalog/wav/FrontEndUI/FE_LobbyCountDown10.wav` | no | 1.000000 | 1.000000 | ui | 90 | music | no |
| `ui.lobby.join` | `_work/audio/catalog/wav/FrontEndUI/FE_LobbyJoin.wav` | no | 1.000000 | 1.000000 | ui | 90 | music | no |
| `ui.lobby.leave` | `_work/audio/catalog/wav/FrontEndUI/FE_LobbyLeave.wav` | no | 1.000000 | 1.000000 | ui | 90 | music | no |
| `ui.lobby.vote_count` | `_work/audio/catalog/wav/FrontEndUI/FE_LobbyVoteCount.wav` | no | 1.000000 | 1.000000 | ui | 90 | music | no |
| `ui.lrud` | `_work/audio/catalog/wav/FrontEndUI/FE_LRUD.wav` | no | 1.000000 | 1.000000 | ui | 90 | music | no |
| `ui.modshop.attach` | `_work/audio/catalog/wav/FrontEndUI/FE_ModShopAttach.wav` | no | 1.000000 | 1.000000 | ui | 90 | music | no |
| `ui.modshop.remove` | `_work/audio/catalog/wav/FrontEndUI/FE_ModShopRemove.wav` | no | 1.000000 | 1.000000 | ui | 90 | music | no |
| `ui.navigate.backward` | `_work/audio/catalog/wav/FrontEndUI/FE_Backward.wav` | no | 1.000000 | 1.000000 | ui | 90 | music | no |
| `ui.navigate.forward` | `_work/audio/catalog/wav/FrontEndUI/FE_Forward.wav` | no | 0.794328 | 1.000000 | ui | 90 | music | no |
| `ui.notice` | `_work/audio/catalog/wav/FrontEndUI/FE_Notice.wav` | no | 2.238721 | 1.000000 | ui | 90 | music | no |
| `ui.previously.out` | `_work/audio/catalog/wav/FrontEndUI/FE_PrevOut.wav` | no | 1.412538 | 1.000000 | ui | 90 | music | no |
| `ui.previously.reward` | `_work/audio/catalog/wav/FrontEndUI/FE_PrevReward.wav` | no | 1.000000 | 1.000000 | ui | 90 | music | no |
| `ui.previously.sparks` | `_work/audio/catalog/wav/FrontEndUI/FE_PrevSparks.wav` | no | 1.412538 | 1.000000 | ui | 90 | music | no |
| `ui.start` | `_work/audio/catalog/wav/FrontEndUI/FE_Start.wav` | no | 1.000000 | 1.000000 | ui | 90 | music | no |
| `ui.stickers.page` | `_work/audio/catalog/wav/FrontEndUI/FE_StickersPage.wav` | no | 1.412538 | 1.000000 | ui | 90 | music | no |
| `ui.tabs.close` | `_work/audio/catalog/wav/FrontEndUI/FE_TabsClose.wav` | no | 2.238721 | 1.000000 | ui | 90 | music | no |
| `ui.tabs.open` | `_work/audio/catalog/wav/FrontEndUI/FE_TabsOpen.wav` | no | 1.000000 | 1.000000 | ui | 90 | music | no |
| `ui.toggle` | `_work/audio/catalog/wav/FrontEndUI/FE_Toggle.wav` | no | 0.707946 | 1.000000 | ui | 90 | music | no |
| `ui.unlock_content` | `_work/audio/catalog/wav/FrontEndUI/HUD_MPFinalScore.wav` | no | 1.000000 | 1.000000 | ui | 90 | music | no |

### 8.2 Unsupported events

| Event | Status | Reason |
| --- | --- | --- |
| `ambience.amboy` | decodable | `None` |
| `ambience.birds_takeoff` | decodable | `None` |
| `ambience.boathorn` | decodable | `None` |
| `ambience.cafe_sign` | decodable | `None` |
| `ambience.church_bell` | decodable | `None` |
| `ambience.cicadas` | decodable | `None` |
| `ambience.crowd_large` | decodable | `None` |
| `ambience.crowd_medium` | decodable | `None` |
| `ambience.crowd_party` | decodable | `None` |
| `ambience.crowd_small` | decodable | `None` |
| `ambience.docks_crane` | decodable | `None` |
| `ambience.docks_loading` | decodable | `None` |
| `ambience.docks_siren` | decodable | `None` |
| `ambience.docks_trucks` | decodable | `None` |
| `ambience.electricity_arcs` | decodable | `None` |
| `ambience.flare` | decodable | `None` |
| `ambience.floodgate` | decodable | `None` |
| `ambience.funfair` | decodable | `None` |
| `ambience.hackney` | decodable | `None` |
| `ambience.helicopter` | decodable | `None` |
| `ambience.hollywood_hills` | decodable | `None` |
| `ambience.la_docks` | decodable | `None` |
| `ambience.la_downtown_highrise` | decodable | `None` |
| `ambience.level_crossing` | decodable | `None` |
| `ambience.mt_haruna` | decodable | `None` |
| `ambience.neon` | decodable | `None` |
| `ambience.oil_derrick` | decodable | `None` |
| `ambience.oil_flames` | decodable | `None` |
| `ambience.oval` | decodable | `None` |
| `ambience.sf_russian_hill` | decodable | `None` |
| `ambience.siren` | decodable | `None` |
| `ambience.sparks` | decodable | `None` |
| `ambience.train_subway` | decodable | `None` |
| `ambience.vehicle_car` | decodable | `None` |
| `ambience.vehicle_lorry` | decodable | `None` |
| `ambience.vehicle_plane_prop` | decodable | `None` |
| `ambience.vehicle_train` | decodable | `None` |
| `ambience.vehicle_tram` | decodable | `None` |
| `engine.decel` | decodable | `None` |
| `engine.flames_loop` | decodable | `None` |
| `engine.induction.1500` | decodable | `None` |
| `engine.induction.2505` | decodable | `None` |
| `engine.induction.3495` | decodable | `None` |
| `engine.induction.4500` | decodable | `None` |
| `engine.induction.5490` | decodable | `None` |
| `engine.steam_loop` | decodable | `None` |
| `engine.supercharger.00` | decodable | `None` |
| `engine.supercharger.02` | decodable | `None` |
| `engine.supercharger.04` | decodable | `None` |
| `engine.supercharger.06` | decodable | `None` |
| `engine.supercharger.08` | decodable | `None` |
| `music.boss.fill.ahead` | decodable | `None` |
| `music.boss.fill.behind` | decodable | `None` |
| `music.boss.loop.close` | unsupported | `streaming-container` |
| `music.boss.loop.losing` | unsupported | `streaming-container` |
| `music.boss.loop.sync` | unsupported | `streaming-container` |
| `music.boss.loop.winning` | unsupported | `streaming-container` |
| `music.boss.pass.boss` | decodable | `None` |
| `music.boss.pass.player` | decodable | `None` |
| `music.boss.start.01` | unsupported | `streaming-container` |
| `music.boss.start.02` | unsupported | `streaming-container` |
| `music.boss.start.03` | unsupported | `streaming-container` |
| `music.boss.start.04` | unsupported | `streaming-container` |
| `music.boss.start.05` | unsupported | `streaming-container` |
| `music.boss.start.06` | unsupported | `streaming-container` |
| `music.boss.start.07` | unsupported | `streaming-container` |
| `music.boss.start.08` | unsupported | `streaming-container` |
| `music.boss.start.09` | unsupported | `streaming-container` |
| `music.checkpoint.high_to_med` | decodable | `None` |
| `music.checkpoint.last` | decodable | `None` |
| `music.checkpoint.loop.high` | unsupported | `streaming-container` |
| `music.checkpoint.loop.last` | unsupported | `streaming-container` |
| `music.checkpoint.loop.low` | unsupported | `streaming-container` |
| `music.checkpoint.loop.med` | unsupported | `streaming-container` |
| `music.checkpoint.loop.sync` | unsupported | `streaming-container` |
| `music.checkpoint.low_to_med` | decodable | `None` |
| `music.checkpoint.med_to_high` | decodable | `None` |
| `music.checkpoint.med_to_low` | decodable | `None` |
| `music.checkpoint.start` | decodable | `None` |
| `music.destruction.high_to_med` | decodable | `None` |
| `music.destruction.loop.high` | unsupported | `streaming-container` |
| `music.destruction.loop.low` | unsupported | `streaming-container` |
| `music.destruction.loop.med` | unsupported | `streaming-container` |
| `music.destruction.loop.sync` | unsupported | `streaming-container` |
| `music.destruction.low_to_med` | decodable | `None` |
| `music.destruction.med_to_high` | decodable | `None` |
| `music.destruction.med_to_low` | decodable | `None` |
| `music.destruction.start` | decodable | `None` |
| `music.ingame.track00` | unsupported | `streaming-container` |
| `music.ingame.track01` | unsupported | `streaming-container` |
| `music.ingame.track02` | unsupported | `streaming-container` |
| `music.ingame.track03` | unsupported | `streaming-container` |
| `music.ingame.track04` | unsupported | `streaming-container` |
| `music.ingame.track05` | unsupported | `streaming-container` |
| `music.ingame.track06` | unsupported | `streaming-container` |
| `music.ingame.track07` | unsupported | `streaming-container` |
| `music.ingame.track08` | unsupported | `streaming-container` |
| `music.ingame.track09` | unsupported | `streaming-container` |
| `music.ingame.track10` | unsupported | `streaming-container` |
| `music.ingame.track11` | unsupported | `streaming-container` |
| `music.ingame.track12` | unsupported | `streaming-container` |
| `music.ingame.track13` | unsupported | `streaming-container` |
| `music.ingame.track14` | unsupported | `streaming-container` |
| `music.ingame.track15` | unsupported | `streaming-container` |
| `music.ingame.track16` | unsupported | `streaming-container` |
| `music.ingame.track17` | unsupported | `streaming-container` |
| `music.ingame.track18` | unsupported | `streaming-container` |
| `music.ingame.track19` | unsupported | `streaming-container` |
| `music.ingame.track20` | unsupported | `streaming-container` |
| `music.ingame.track21` | unsupported | `streaming-container` |
| `music.ingame.track22` | unsupported | `streaming-container` |
| `music.menu.loading` | decodable | `None` |
| `music.menu.opening` | unsupported | `streaming-container` |
| `music.menu.press_start` | unsupported | `streaming-container` |
| `music.menu.press_start_fill` | decodable | `None` |
| `music.menu.race_fail_fill` | decodable | `None` |
| `music.menu.race_pass_fill` | decodable | `None` |
| `music.menu.variation0` | unsupported | `streaming-container` |
| `music.menu.variation1` | unsupported | `streaming-container` |
| `music.menu.variation2` | unsupported | `streaming-container` |
| `music.menu.variation3` | unsupported | `streaming-container` |
| `music.race.finished` | unsupported | `streaming-container` |
| `music.vista.Amboy` | unsupported | `streaming-container` |
| `music.vista.AmboyBowl` | unsupported | `streaming-container` |
| `music.vista.BarcelonaBowl` | unsupported | `streaming-container` |
| `music.vista.BarcelonaGracia` | unsupported | `streaming-container` |
| `music.vista.BarcelonaOval` | unsupported | `streaming-container` |
| `music.vista.Brighton` | unsupported | `streaming-container` |
| `music.vista.Hackney` | unsupported | `streaming-container` |
| `music.vista.HollywoodHills` | unsupported | `streaming-container` |
| `music.vista.LADocks` | unsupported | `streaming-container` |
| `music.vista.LADowntown` | unsupported | `streaming-container` |
| `music.vista.LAFigureOfEight` | unsupported | `streaming-container` |
| `music.vista.LAHighRise` | unsupported | `streaming-container` |
| `music.vista.LARiver` | unsupported | `streaming-container` |
| `music.vista.MountHaruna` | unsupported | `streaming-container` |
| `music.vista.NYDumbo` | unsupported | `streaming-container` |
| `music.vista.SFRussianHill` | unsupported | `streaming-container` |
| `music.vista.SFSausalito` | unsupported | `streaming-container` |
| `music.vista.TokyoShutoko` | unsupported | `streaming-container` |

## 9. Verification

`python probes/audio/verify_audio_catalog.py` -> **20,613 checks,
20,613 passed, 0 failed**.

The checks include:

- bank inventory totals, every wave's bounds/codec/rate/channels and loop flag;
- entity/group/object counts and every entity->graph reference;
- graph parse coverage and every sound component's bank/wave list;
- every event's status, variant status, typed unsupported reason and coverage;
- every manifest entry's provenance, file existence, byte size, SHA-256, loop
  sanity, codec/rate/channel sanity and data offset;
- **two independent decodes per entry**, both byte-identical to the stored WAV;
- size accounting (`new + reused = total`, entry sum = reported total);
- no duplicate UID/file hash conflicts;
- integration-contract files, gains, rates and loop fields.

Determinism: the manifest is rebuilt from the retail PAK bytes each run; the
verifier decodes each entry twice and compares the WAV hashes to the file. A
second catalog run produces the same `audio-manifest.json` bytes.

## 10. Limits and non-claims

1. **Streaming music is not decoded.** 70 music events are
   `unsupported/streaming-container`: `MenuMusic`, `InGameMusic`,
   `InGameCustomMusic`, `VistaMusic`, and the `ENV_*_ST`/`ENV_Battle`/
   `ENV_Fireworks` banks. Their `WAVE` headers are catalogued; the sample
   data is external and no WAV is produced.
2. **PCM16 is not decoded.** Four sync loops in streaming banks use format 3.
   They are `unsupported/streaming-container` before the codec question
   matters; no PCM16 WAV is claimed.
3. **Ambience is catalogued, not decoded.** 38 `AMB_*` entities and their
   graphs/waves are `decodable`; their banks are mostly non-streaming
   environment banks. They are left out of the manifest to keep it focused.
4. **Not the retail mixer.** Priority, ducking, sends/returns, EQ, occlusion,
   cone, rolloff, the retail limiter and the Ovis graph runtime are not
   reproduced. The contract marks integration choices `provisional`.
5. **Retail gain is only literal for some one-shots.** Most loops have a
   control-driven level/frequency; their curve points are recorded, but the
   page must either apply the curve or use a documented neutral placeholder.
6. **No engine-run or multi-car mix claim.** Six `Race_V8` RPM loops are
   reused from P62/P71. The other 53 vehicle banks are catalogued but not
   mapped to a car roster; AI banks are 36 kHz.
7. **No car-to-bank roster claim.** The entity list names `Race_V8`, `Chevy_V8`,
   `Ford_i5`, etc.; the E1 car mapping remains a separate task.
8. **No full-game audio claim.** This catalog covers bank/entity/event
   provenance and the practical UI/race/power-up set, not every retail
   behaviour.
9. **Decoded WAVs are game data.** They live under `_work/audio/` and are not
   committed. A shipped build needs its own asset pipeline or a wasm ADPCM
   decoder.
10. **No browser capture in this task.** The existing E1 audio integration is
    untouched; this catalog is data/provenance only.

## 11. Reproduction

```powershell
cd "C:\Users\ismailemin\Documents\Blur Web"
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

# 1. Build the catalog, manifest and contract (reads PAKs, writes _work only)
& $py probes/audio/audio_catalog.py

# 2. Verify (>=250 checks; two decode runs per manifest entry)
& $py probes/audio/verify_audio_catalog.py

# 3. Re-render this document from the JSON evidence
& $py probes/audio/render_audio_catalog_doc.py
```

## 12. Evidence index

| Path | What |
| --- | --- |
| `_work/audio/audio-catalog.json` | 193 banks, 2,732 waves, 228 entities, 365 graphs, 334 events, per-wave provenance |
| `_work/audio/audio-manifest.json` | 220 decoded/reused entries with SHA-256, bytes, loop and duration |
| `_work/audio/integration-contract.json` | Event -> file/loop/gain/rate/bus/priority/ducking |
| `_work/audio/audio-catalog-verify.json` | 20,613-check verifier report |
| `_work/audio/catalog/graphs/` | Decoded `.dat` copies (365) |
| `_work/audio/catalog/wav/` | 160 newly decoded WAVs, grouped by bank |
| `_work/logs/audio/catalog-run*.log` | Catalog build logs |
| `_work/logs/audio/verify-full1.log` | Full verifier output |
| `_work/logs/audio/docdata.log` | Summary numbers used by this document |

No game data, decoded fixture or generated WASM is committed. The decoded
WAVs, `.dat`/`.baf` copies and logs live under `_work/` only.

