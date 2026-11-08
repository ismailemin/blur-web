# Localization — shipped `.loc` format and the shell string catalog

**Date:** 8 November 2026
**Owner:** L10N1 (sub-agent), data/tooling only
**Scope:** new `probes/loc/tools/{olt,amax_loc,required_keys,build_loc_catalog,verify_loc_catalog}.py`,
outputs under `_work/loc/` and `_work/logs/loc/`, and this document. No
`probes/e1-drive`, `probes/vehicle-pipeline`, `tools/`, `upstream/`, `game-data/`
or web entry point is changed. Nothing is committed and no browser capture is run.

**Result:** all **23** shipped `*.loc` files are decoded from their bytes:
**5,098** keys across **5** locales (`en, fr, de, it, es`), UTF-16LE values, and a
table-based LocId (`0x`-hash) lookup. The shell/HUD catalog defines **500 required
slots**; **490 resolve** in every locale from shipped data and **10 are typed
missing** (never filled with English prose). The independent verifier is
**PASS 2533/2533**, two builds are byte-identical, and the browser payload is
one **23 KB** shell subset per locale (≈6.2 KB gzipped) or one **369–393 KB**
full-locale file (≈84–90 KB gzipped).

---

## 1. Format — proven from the bytes

Every `*.loc` in `gamedata.pak` is an **OLTX v1** container (magic `OLTX`,
version `1`) nested inside the PAK's zlib codec (codec 2). The 23 files agree on
every header field below; the reader rejects any deviation instead of falling
back.

```text
0x00  char[4]   "OLTX"
0x04  uint32    version = 1
0x08  uint32    offset base = 16 (every file)
0x0c  uint32    locale-area offset, relative to 0x08
0x10  uint32    middle-header size = 12; locale table starts at 0x10 + 12 = 0x1c
0x14  uint32    locale count = 5
0x18  uint32    key-table offset, relative to 0x08
0x1c  locale[5] (24 bytes each)
        char[4]  code ("en\0\0", "fr\0\0", ...)
        u8[12]   zero
        uint32   blob offset (absolute)
        uint32   blob size
```

Proof of the two relative fields: `0x08 + 0x0c` equals the first locale blob
offset and `0x08 + 0x18` equals the key table offset in all 23 files (for
`vehicles.loc`: `16 + 5838 = 5854`, `16 + 132 = 148`). The locale table starts at
`0x10 + (value at 0x10) = 0x1c` in all 23 files, and `0x14` equals the number of
24-byte locale records.

### 1.1 Key table

At `0x08 + 0x18`:

```text
uint32  key count
uint32  stride = 8
count x { uint32 LocId; uint32 name offset relative to the key table }
NUL-terminated ASCII key names, between the rows and the locale area
```

Key names are ASCII. 5,094 of 5,098 names match `[A-Za-z0-9_]+`; the four
exceptions are shipped as-is and tracked by the verifier:

| key | file |
| --- | --- |
| `MP_UNLOCKS_BMWM3(E92)` | `multiplayer.loc` |
| `MP_UNLOCKS_CHEVROLETSO-CALHHR` | `multiplayer.loc` |
| `MP_UNLOCKS_DRIVER'SED.` | `multiplayer.loc` |
| `"` (a single quote character) | `multiplayerhelptips.loc` |

### 1.2 Locale blob

```text
uint32  value count (must equal the key count)
uint32  stride = 8
count x { uint32 LocId; uint32 value offset relative to the blob }
UTF-16LE, NUL-terminated (two zero bytes on an even boundary) values
```

Every shipped locale blob has the **same count as the key table**, so a key is
never structurally absent from a locale. The reader validates:

- magic/version/header constants and contiguous locale blobs;
- `count == key_count` and `stride == 8`;
- every value hash exists in the key table and occurs once;
- 2-byte alignment, termination, strict UTF-16LE decoding (unpaired surrogates
  fail), no embedded `U+0000`;
- values do not overlap, and all gaps/tails are zero padding.

### 1.3 LocId is a table hash, not a recomputed id

A **LocId** is the 32-bit hash stored in the table; the same integer appears in
the key table and in every locale blob. The hash algorithm was **not derived**:
CRC-32, FNV-1, FNV-1a, DJB2, SDBM, Jenkins one-at-a-time, Murmur3 (seeds
0/1/0xffffffff) over ASCII, lowercase, NUL-terminated and UTF-16LE forms were
tested against all 197 `vehicles.loc` keys and matched **0/197**. The tables are
therefore authoritative, and no id is ever computed from a key name.

The same LocId can exist in two different files (separate hash spaces). This is
why the catalog always carries the **file** with the id and why the runtime
catalog uses `"<file>:<KEY>"` keys.

### 1.4 Data quirks (preserved, not repaired)

- **4 duplicate key names** across two files, with **conflicting values**:
  `MP_MESSAGE_OF_THE_DAY`, `POB_COMMUNITY_TMS_TEXT`, `POB_DLC_TMS_TEXT`,
  `POB_NEWS_TMS_TEXT` exist in both `multiplayer.loc` and `multiplayerts.loc`.
  Both values and both provenance rows are kept; the duplicate is flagged, never
  merged.
- **46 empty strings** exist in shipped data (`common.loc`, `frienddemands.loc`,
  `multiplayerhelptips.loc`, `multiplayerts.loc`). They are copied as `""`; the
  builder does not substitute English.
- `subtitles.loc` has a valid key table with **0** keys (five 8-byte blobs).

---

## 2. Inventory — 23 files, 5,098 keys

All files live under `\gamedata\xt\loc\` in `game-data/Blur/cache/gamedata.pak`.
`stored` is the PAK-compressed size, `logical` the decoded OLTX size. Sizes after
each locale are `blobOffset+blobSize`.

| file | stored B | logical B | keys | en | fr | de | it | es |
|---|---:|---:|---:|---|---|---|---|---|
| `achievements.loc` | 29,217 | 119,948 | 294 | 11680+18088 | 29768+21618 | 51386+21890 | 73276+23540 | 96816+23132 |
| `cityandroutenames.loc` | 4,301 | 21,694 | 103 | 2886+3722 | 6608+3858 | 10466+3756 | 14222+3722 | 17944+3750 |
| `common.loc` | 87,172 | 237,468 | 833 | 22338+39190 | 61528+43706 | 105234+43668 | 148902+44248 | 193150+44318 |
| `facebook.loc` | 12,958 | 56,455 | 84 | 2943+9654 | 12597+10106 | 22703+11582 | 34285+11250 | 45535+10920 |
| `fandemands.loc` | 2,988 | 11,622 | 43 | 1098+1658 | 2756+2024 | 4780+2056 | 6836+2302 | 9138+2484 |
| `frienddemands.loc` | 21,074 | 84,933 | 252 | 7467+14392 | 21859+14818 | 36677+16302 | 52979+15602 | 68581+16352 |
| `helptips.loc` | 46,637 | 182,444 | 172 | 3954+31350 | 35304+37914 | 73218+36606 | 109824+37288 | 147112+35332 |
| `hud.loc` | 6,304 | 18,914 | 101 | 2846+2926 | 5772+3354 | 9126+3250 | 12376+3278 | 15654+3260 |
| `info.loc` | 13,649 | 53,319 | 181 | 5037+8980 | 14017+9582 | 23599+10100 | 33699+9752 | 43451+9868 |
| `localiser.loc` | 1,947 | 6,937 | 43 | 1111+1180 | 2291+1148 | 3439+1164 | 4603+1172 | 5775+1162 |
| `multiplayer.loc` | 133,236 | 399,433 | 1,316 | 42505+63636 | 106141+71512 | 177653+71938 | 249591+74036 | 323627+75806 |
| `multiplayerhelptips.loc` | 25,157 | 129,938 | 128 | 2308+22320 | 24628+26134 | 50762+26136 | 76898+26266 | 103164+26774 |
| `multiplayerts.loc` | 322 | 1,664 | 4 | 268+1204 | 1472+48 | 1520+48 | 1568+48 | 1616+48 |
| `popups.loc` | 32,273 | 149,394 | 234 | 7688+26482 | 34170+28244 | 62414+31076 | 93490+27972 | 121462+27932 |
| `profile.loc` | 10,307 | 47,745 | 87 | 2735+8142 | 10877+9360 | 20237+9726 | 29963+9066 | 39029+8716 |
| `racebookcommon.loc` | 26,187 | 82,715 | 333 | 9391+13530 | 22921+14970 | 37891+15198 | 53089+14588 | 67677+15038 |
| `racebookui.loc` | 15,450 | 50,633 | 125 | 3883+8566 | 12449+9584 | 22033+9696 | 31729+9404 | 41133+9500 |
| `richpresence.loc` | 3,222 | 11,123 | 33 | 973+1808 | 2781+1780 | 4561+1968 | 6529+2474 | 9003+2120 |
| `scoring.loc` | 14,171 | 48,692 | 189 | 8452+6740 | 15192+8180 | 23372+8098 | 31470+8678 | 40148+8544 |
| `singleplayer.loc` | 33,028 | 120,343 | 281 | 8735+20840 | 29575+23430 | 53005+22368 | 75373+22532 | 97905+22438 |
| `subtitles.loc` | 69 | 196 | 0 | 156+8 | 164+8 | 172+8 | 180+8 | 188+8 |
| `twitter.loc` | 7,353 | 45,649 | 65 | 2213+7874 | 10087+8470 | 18557+8998 | 27555+9272 | 36827+8822 |
| `vehicles.loc` | 10,872 | 50,508 | 197 | 5854+8658 | 14512+8976 | 23488+8768 | 32256+9108 | 41364+9144 |
| **total** | **537,894** | **1,931,767** | **5,098** | | | | | |

Per-file hashes, PAK offsets, per-locale record offsets/sizes and empty counts are
in `_work/loc/inventory.json` (SHA-256 `cb0f7d93…faad26`).

Encoding: values are UTF-16LE; the catalog emits UTF-8 JSON. No byte substitution,
trimming or normalisation is applied.

---

## 3. Required string set and how each id is proven

`probes/loc/tools/required_keys.py` holds an explicit `(slot, file, key)` table;
the builder fails if a key is missing. Dynamic categories come from data:

| category | slots | resolved | proof |
|---|---:|---:|---|
| `vehicle` (62 names + 62 manufacturers) | 124 | **122** | 61 `AmaxVehicle` LocIds + `VEH_MAN_*`; `DefaultCar` is typed missing |
| `manufacturer` (unique) | 24 | **24** | `AmaxManufacturer` tag normalised to `VEH_MAN_<TAG>` (24/24 exist) |
| `level` (19 city names) | 19 | **19** | `AmaxCity` base `LocString`; `City.Name.lower() == level directory` for all 19 |
| `level-variant` (route names) | 59 | **59** | `AmaxRoute` base `LocString`, grouped by `Route.City` |
| `mode` | 21 | **21** | 5 MP race types, 5 SP event kinds, Fan Run, Driving School, 9 split-screen modes |
| `power-up` | 44 | **36** | `ui.bin` `UiPerkInfo` ids + `PIK_*`/`CMN_*` short names + prose tips |
| `hud` | 62 | **62** | `hud.loc` labels and hit-feed atoms |
| `menu` | 57 | **57** | `common.loc` / garage / `racebookcommon.loc` |
| `results` | 42 | **42** | `multiplayer.loc` / `singleplayer.loc` / `racebookcommon.loc` |
| `countdown` | 13 | **13** | `CMN_1/2/3`, `IDS_CMN_GO`, `CMN_GET_READY`, `CMN_SPLIT_SCREEN_READY`, MP timers |
| `errors` + dialogs | 35 | **35** | `popups.loc` + two MP join errors |
| **total** | **500** | **490** | |

### 3.1 Vehicles — 62 records → 61 names + 1 typed missing

`_work/vehicle-pipeline/cars.json` has 62 physics records. Each is mapped to its
`AmaxVehicle` wrapper by:

1. provable class-C alias (`c-aliases.json` `identity.amaxTag`), else
2. exact body-model stem (`AmaxVehicle.tag.lower() == model stem`),
3. the resulting `AmaxVehicle.dynamics` record id must equal the car record id.

61/62 map. **`DefaultCar` (record 8, id 515172551)** has no `\models\vehicles\defaultcar.model`,
no alias identity, no `AmaxVehicle` record and no unique dynamics match. Both its
name and manufacturer slots are typed missing; no name is invented (there is no
`VEH_MOD_DEFAULT*` key). The display key is `locStringFull` when non-zero, else
`locString` (the same rule the committed HUD catalog uses).

Manufacturer names are not serialized as text in `AmaxManufacturer` (only
`UiTexture`); the shipped `VEH_MAN_*` keys are matched by normalising the exact
manufacturer tag (uppercase, strip non-alphanumerics). All 24 manufacturer
records resolve, e.g. `LandRover → VEH_MAN_LANDROVER`, `AC Schnitzer →
VEH_MAN_ACSCHNITZER`, `Rat Rod → VEH_MAN_RATROD`, `Viper → VEH_MAN_VIPER`
(English value `Dodge`, as shipped).

### 3.2 Levels — 19 city names + 59 route variants

`City.Name` lowercased equals the 19 level directory names exactly, and every
`City`/`Route` base `LocString` resolves in `cityandroutenames.loc`:

| level | city key | en | routes |
|---|---|---|---|
| `jpn_mharuna` | `CRN_MOUNT_HARUNA` | Mount Haruna | `CRN_ROUTE_0`, `CRN_MOUNT_HARUNA_1` (Descent), `CRN_OBJTEST` |
| `jpn_tokyo_shutoko` | `CRN_TOKYO_SHUTOKO` | Tokyo Shutoko | `CRN_ROUTE_0`, `CRN_TOKYO_SHUTOKO_2`, `_4`, `CRN_OBJTEST` |
| `showroom` | `CRN_SHOWROOM` | Show Room | `CRN_SHOWROOM` |
| `spa_barcelona_bowl_multiplayer` | `CRN_BARCELONA_NAME` | Barcelona | `CRN_BARCELONA_BOWL_MULTIPLAYER` (La Carretera) |
| `spa_barcelona_gracia` | `CRN_BARCELONA_GRACIA` | Barcelona Gracia | `CRN_ROUTE_0`, `_1`, `_2`, `_5`, `CRN_OBJTEST` |
| `spa_barcelona_oval` | `CRN_BARCELONA_OVAL` | Barcelona Oval | `CRN_ROUTE_0`, `_1`, `_2`, `CRN_OBJTEST` |
| `uk_brighton` | `CRN_BRIGHTON` | Brighton | `CRN_ROUTE_0`, `_1`, `_2`, `_3`, `CRN_OBJTEST` |
| `uk_london_hackney` | `CRN_HACKNEY` | Hackney | `CRN_ROUTE_0`, `_1`, `_2`, `_4`, `CRN_OBJTEST` |
| `usa_amboy` | `CRN_AMBOY` | Amboy | `CRN_ROUTE_0`, `_1` (Route 66), `_3`, `CRN_OBJTEST` |
| `usa_amboy_multiplayer` | `CRN_AMBOY` | Amboy | `CRN_AMBOY_MULTIPLAYER` (The Dust Bowl) |
| `usa_la_downtown` | `CRN_LA_DOWNTOWN` | LA Downtown | `CRN_ROUTE_0`, `_1`, `_4`, `_6`, `CRN_OBJTEST` |
| `usa_la_downtown_multiplayer` | `CRN_LA_DOWNTOWN_MULTIPLAYER` | LA Downtown | `CRN_LA_DOWNTOWN_FIGUREOF8` (Figure of 8) |
| `usa_la_longbeachdocks` | `CRN_LA_DOCKS` | LA Docks | `CRN_ROUTE_0`, `_2`, `_3` |
| `usa_la_multiplayer_highrise` | `CRN_LA_DOWNTOWN` | LA Downtown | `CRN_LA_DOWNTOWN_MULTIPLAYER_HIGHRISE` (LA Heights) |
| `usa_la_observatory` | `CRN_LA_OBSERVATORY` | Hollywood Hills | `CRN_ROUTE_0`, `_1`, `_2` |
| `usa_la_river` | `CRN_LA_RIVER` | LA River | `CRN_ROUTE_0`, `_3`, `_6`, `CRN_OBJTEST` |
| `usa_ny_dumbo` | `CRN_NY_DUMBO` | NY Dumbo | `CRN_ROUTE_0`, `_2`, `_3`, `CRN_OBJTEST` |
| `usa_sanfran_russianhill` | `CRN_SANFRAN_RUSSIANHILL` | SanFran Russian Hill | `CRN_ROUTE_0`, `_1` |
| `usa_sanfran_sausalito` | `CRN_SANFRAN_SAUSALITO` | SanFran Sausalito | `CRN_ROUTE_0`, `_1`, `_2` |

**19/19 city names resolve, but only 16 distinct English values** are shipped:
`Amboy` is shared by `usa_amboy` and `usa_amboy_multiplayer`; `LA Downtown` is
shared by `usa_la_downtown`, `usa_la_downtown_multiplayer` and
`usa_la_multiplayer_highrise`. This is the data, not a catalog error. A shell that
needs unique labels must render city **and** variant (e.g. `LA Downtown — LA
Heights`), both of which are present. `CRN_ROUTE_0` / `CRN_OBJTEST` are shipped
generic route names and are kept as variants.

### 3.3 Power-ups — 11 pickups

`PickupType` has 11 entities. Names come from `ui.bin` `UiPerkInfo.loc_id_name`
(which resolves to `common.loc` `CMN_*`) and the canonical `PIK_*` short names;
hit-feed labels come from `past_loc_id_name` (`hud.loc` `HUD_PT_*`). Descriptions
are **not** a serialized field: `multiplayerhelptips.loc` has prose tips that name
8 of the 11 pickups, recorded with `binding: "prose-name-mention"` so they cannot
be mistaken for a schema field.

| pickup | name key | HUD name key | hit key | description |
|---|---|---|---|---|
| Barge | `PIK_BARGE` | `CMN_BARGE` | `HUD_PT_BARGED` | `MHLP_11` |
| Nitrous | `PIK_NITRO` | `CMN_NITRO` | `HUD_PT_NITROED` | `MHLP_7` |
| Shock | `PIK_SHOCK` | `CMN_SHOCK` | `HUD_PT_SHOCKED` | `MHLP_13` |
| Shunt | `PIK_SHUNT` | `CMN_SHUNT` | `HUD_PT_SHUNTED` | `MHLP_9` |
| Blindfire (Bolt) | `PIK_BLINDFIRE` | `PIK_BLINDFIRE` | `HUD_PT_BOLTED` | `MHLP_10` |
| Bomb (Mine) | `PIK_BOMB` | `CMN_BOMB` | `HUD_PT_BOMBED` | `MHLP_12` |
| Repair | `PIK_REPAIR` | `CMN_REPAIR` | `HUD_PT_REPAIRED` | `MHLP_49` |
| Shield | `CMN_SHIELD` | `CMN_SHIELD` | `HUD_PT_SHIELDED` | `MHLP_14` |
| SuperShield | `CMN_SUPER_SHIELD` | `CMN_SUPER_SHIELD` | `HUD_PT_SHIELDED` | — |
| Fan | `CMN_FAN` | — | — | — |
| Stopwatch | — | — | — | — |

### 3.4 Missing keys — complete list (10)

| slot | reason |
|---|---|
| `vehicle.8.name` | `DefaultCar` has no model, alias, `AmaxVehicle` or LocId |
| `vehicle.8.manufacturer` | same record; no manufacturer id |
| `powerup.Stopwatch.name` | no `PIK_*`/`CMN_*` key exists; no `UiPerkInfo` entry |
| `powerup.Stopwatch.hud_name` | no `UiPerkInfo` entry |
| `powerup.Stopwatch.hit` | no `HUD_PT_*` atom |
| `powerup.Stopwatch.description` | no per-pickup description/tip |
| `powerup.Fan.hud_name` | no `UiPerkInfo` entry (name `CMN_FAN` does exist) |
| `powerup.Fan.hit` | no `HUD_PT_*` atom |
| `powerup.Fan.description` | no tip names the Fan pickup |
| `powerup.SuperShield.description` | no tip names SuperShield |

Every other required slot resolves in **all five locales**. Missing slots are
emitted as `null` plus a typed reason in `coverage.json`, `slots.json` and
`shell/<locale>.json.missing`; they are never replaced with English prose.

### 3.5 Per-locale coverage

Because the format stores one value per key per locale, all five locales carry
all 5,098 keys. Required-slot coverage is identical:

| locale | slots | resolved | typed missing | empty in shell |
|---|---:|---:|---:|---:|
| `en` | 500 | 490 | 10 | 0 |
| `fr` | 500 | 490 | 10 | 0 |
| `de` | 500 | 490 | 10 | 0 |
| `it` | 500 | 490 | 10 | 0 |
| `es` | 500 | 490 | 10 | 0 |

The catalog itself contains 46 shipped empty strings (not in required slots).
`en` is the only fallback locale shipped for every file; there is no second
complete locale. Values that are non-empty in a non-`en` locale are 100 %
shipped translations — the catalog does not mix English into them.

---

## 4. Catalog artifacts

Built by `probes/loc/tools/build_loc_catalog.py`; all files are disposable
(`_work/`, never committed).

| artifact | bytes | SHA-256 |
|---|---:|---|
| `_work/loc/strings.json` | 5,624,224 | `2c82ee26aa22299d7e8b92fd8ef293c5d9c1e7e3f860222a3a938c16f692f473` |
| `_work/loc/inventory.json` | 24,653 | `cb0f7d934d49d9a41c505527714d97577e2a260f7c5b2691fdd190dde8faad26` |
| `_work/loc/slots.json` | 184,415 | `f360bd63ec164141eed31ab09ebc4d1011fb169704e052e67e6598953ba7311a` |
| `_work/loc/coverage.json` | 3,920 | `e0d398d77099ebd08e5cacfb319637511e6a6b8a7f77a0c568c602271dac1807` |
| `_work/loc/index.json` | 7,501 | `6d61059068e18295368832c0666e6fcee0d10ffa632a536ba71388b3eba0cf24` |
| `_work/loc/verify.json` | 224,310 | `abff73215cb8111edb33420fdd83ef3688812ef82a588c8805bdafdef9ccb4db` |

Per locale (full file / shell subset):

| locale | full bytes | full SHA-256 | shell bytes | shell SHA-256 | payload SHA-256 |
|---|---:|---|---:|---|---|
| `en` | 368,496 | `39a30c8ccdedbf9d3f4afd44cb000f919034e9ad649d13a459a123b7db83e652` | 23,467 | `53ddf68352844b8fda6d78f52e77c09a46a759051b43f3c620673dbdf866e307` | `3ed4e80e65a32866c82dbaf3d985b41c4a7a4269ea8ea43e0e556ea792c380b5` |
| `fr` | 391,393 | `3fc2b42e73fe6827186cda8c4551b46dd3de275e69f31aec2950f2cc3cc1d1c6` | 24,445 | `a9e0d53288042929a249bbaebc12e62ad70979d2c9f336ec627cdd2f0d543163` | `8755d6d19aca686037c80484b31edaee7750653a0c650f11c91ad89f0af1ca51` |
| `de` | 391,764 | `62c693059a8773e48125905454c8685402f29e6221fb96687fec8dbde293d7dd` | 24,407 | `6b10e46697c37ca339a8db3f1c6b1926cb1e1d96e7318b26ff5e13065d023f44` | `069211e7560ed59b4c5c35f871f922faf1ba06109748f2d4b95b859cc2022cb1` |
| `it` | 391,390 | `3490c846e52d72d645bd0b2c0125fc53d925c8aa9e8977bb2666c05ac82e4b52` | 24,283 | `17c4f4f8ff941ea424248863330dd237cc01817c735f4c3ca859a54b128eda91` | `1699f3fe0e62d196998ff118991ecedb321be10bf24025c893def11ddbf33ce6` |
| `es` | 392,965 | `65e24e969c60064ff8a07f5e3d11cbcff0b62709384ebff1a1a196e3cd51c598` | 24,446 | `5948ac11bd5fa95e2bab2ef02aa25db52f8474bb3e43f1259a3d387ec408c6c4` | `8944ffd2fee26e9396bd9306dea6ed8b679884a2968fb1005edca9f5cde3db42` |

Hash definitions:

- **payload hash** — SHA-256 of the canonical JSON (`sort_keys`, indent 1,
  UTF-8, trailing newline) of `strings.json[locale]` (`{key: [values]}`);
  this is `strings.json._hashes[locale]`.
- **full/shell hash** — SHA-256 of the complete per-locale document bytes.

Canonical shape of `strings.json` (locale at top level, metadata under `_` keys):

```json
{
  "en": { "CMN_BACK": ["Back"], "MP_MESSAGE_OF_THE_DAY": ["…", "…"] },
  "fr": { "CMN_BACK": ["Retour"], "…": ["…"] },
  "de": {}, "it": {}, "es": {},
  "_provenance": {
    "en": {
      "CMN_BACK": [{"file": "common.loc", "offset": 38210, "locId": "be315255", "keyOffset": 2712}]
    }
  },
  "_hashes": {"en": "3ed4e80e…", "fr": "8755d6d1…", "de": "069211e7…", "it": "1699f3fe…", "es": "8944ffd2…"},
  "_meta": {
    "counts": {"files": 23, "keys": 5098, "uniqueKeyNames": 5094, "locales": 5, "slots": 500, "slotsResolved": 490, "slotsMissing": 10},
    "sources": {"gamedataPak": {"sha256": "…"}, "amax": {"sha256": "…"}}
  }
}
```

`[values]` has one element per contributing file (always 1 except the four
duplicate names). `provenance` is parallel to `[values]`; `offset` is the
absolute byte offset of the UTF-16LE value inside the decoded file, `keyOffset`
the absolute offset of the key name.

---

## 5. Integration contract (`shell.js` / HUD)

### 5.1 Files to load

```text
_work/loc/index.json           7.5 KB   (2.4 KB gz)  — locale list, hashes, sizes
_work/loc/shell/<code>.json   23–24 KB  (6.2–6.7 KB gz) — required slots, fallback applied
_work/loc/locales/<code>.json 369–393 KB (84–90 KB gz)  — every key, `"<file>:<KEY>"`
```

Ship **`shell/<code>.json`** for the normal shell/HUD. It is generated at build
time, so the page never needs fallback logic and never loads 5 × 370 KB. Load
`locales/<code>.json` only for a debug/credits screen that needs arbitrary keys.

### 5.2 Lookup

```js
// shell bundle
const l10n = await (await fetch(`/loc/shell/${locale}.json`)).json();
l10n.strings["shell.main_menu"];            // "MAIN MENU"
l10n.strings["vehicle.24.name"];            // "LRX"
l10n.strings["level.usa_la_river.name"];    // "LA River"
l10n.missing["powerup.Stopwatch.name"];     // typed reason (never English prose)

// full catalog
const loc = await (await fetch(`/loc/locales/${locale}.json`)).json();
loc.strings["hud.loc:HUD_COUNTDOWN"];       // "%1d%c%02d"
```

Slot names are stable contract ids (`vehicle.<recordIndex>.name`,
`level.<directory>.name`, `mode.*`, `hud.*`, `result.*`, `error.*`,
`powerup.<Pickup>.{name,hud_name,hit,description}`). Keys are stable shipped keys
(`common.loc:CMN_BACK`).

### 5.3 Fallback order

1. requested locale value;
2. `en` value, **only** when the requested value is absent or `""`;
3. `null` + the typed reason from `missing`.

There is no other complete locale, so no other fallback is attempted. The shell
subset already applies steps 1–3; `locales/<code>.json` is raw shipped data (empty
stays empty) for exact-parity rendering. Missing values are never rendered as
English and never replaced by a hard-coded label — render the typed marker or a
neutral placeholder such as `—`.

Locale codes shipped: `en, fr, de, it, es`. `en` is the default. The catalog has
no translation pipeline and no user-facing text of its own.

---

## 6. Verification

`python probes/loc/tools/verify_loc_catalog.py` re-reads the PAK and re-implements
the OLTX reader independently of `olt.py` (no import), then compares every value
and hash. Result: **PASS 2533/2533, 0 failures** (`_work/loc/verify.json`).

Check groups:

| group | checks | what is proved |
|---|---:|---|
| per-file format (`format.*`) | 299 = 23 × 13 | magic/version/base/middle/locale count/order, key-table position, locale area, record count, unique LocIds/names, file SHA-256, key-count match |
| encoding (`encoding.*`) | 345 = 23 × 5 × 3 | every value decodes as UTF-16LE, no `U+0000`, byte-exact round-trip at the recorded offset |
| catalog agreement (`values.*`) | 116 | catalog value equals the independent parse for every key/locale (plus the empty-string total) |
| slots (`slot.*`) | 1,470 = 490 × 3 | every resolved slot's key exists, its LocId matches the table, and all 5 locales are non-empty |
| vehicle slots (`vehicle.*`) | 122 = 61 × 2 | all 61 resolved names non-empty/strip-non-empty in every locale |
| key charset/duplicates/conflicts | 5 + 12 | 5,098 keys, 5,094 names, 4 known duplicates, 4 known conflicts, 4 odd names |
| locale files / index / payload | 15 + 10 + 5 | canonical bytes, full-file hash, payload hash, index hash/size |
| coverage / shell | 16 + 20 | 490/500 per locale, shell fallback equals the slot table |
| categories / slot totals / missing | 9 + 6 | every static category is fully resolved; exactly 10 typed missing slots |
| levels / vehicles / manufacturers / power-ups | 19 + 4 + 2 + 4 | 19 city names, 59 variants, 61 mapped + `DefaultCar` typed, 24 manufacturers, 44 power-up slots |
| sources / catalog / artifacts / hashes | 6 + 5 + 10 + 1 | input hashes, catalog counts + top-level locale shape, canonical output files, locale hash set |
| **total** | **2,533** | |

Determinism: two consecutive builds produce byte-identical `written` maps
(verified by comparing `build-run1.json` and `build-run2.json`); `strings.json`
and all per-locale files hash identically across runs.

Commands:

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

& $py probes/loc/tools/build_loc_catalog.py
& $py probes/loc/tools/verify_loc_catalog.py
```

---

## 7. Limits

- **Data only.** No browser/GPU capture, no HUD screenshot, and no shell
  integration is claimed. The contract in §5 is a build-time interface, not a
  rendered screen.
- **No translation.** The catalog copies shipped strings. It does not verify that
  a translation is good, complete or even different from English; it only proves
  the bytes and the key bindings.
- **LocId hash unknown.** The table hash function was not derived; ids are always
  read from the table. A new runtime id cannot be computed from a key name.
- **`DefaultCar` has no shipped name.** 61/62 physics records resolve; the 62nd is
  a dev record with no model, no `AmaxVehicle` and no LocId. It is reported, not
  filled.
- **Power-up descriptions are prose tips, not schema fields.** 8/11 bind to
  `MHLP_*` text that names the pickup; 3 have no description at all.
- **Level display names are not unique.** 19/19 resolve, 16 distinct English
  values; `Amboy` (2) and `LA Downtown` (3) are shared. Use city + variant.
- **4 conflicting duplicate keys** exist across `multiplayer.loc` and
  `multiplayerts.loc`; both values are preserved and flagged. Picking one is a
  product decision, not a data conclusion.
- **46 empty shipped strings** are preserved; the shell fallback treats empty as
  "fall back to `en`", while the full locale file keeps the empty string for
  exact parity.
- **Inputs from other probes.** `cars.json`, `c-aliases.json` and
  `powerups.json` are `_work` outputs of the vehicle/power-up probes; their
  SHA-256 values are pinned in `strings.json.sources`. A clean `_work/`
  requires those probes to be rebuilt first. The `.loc`, `amax.bin` and level
  directory inputs are game data and are self-contained.
