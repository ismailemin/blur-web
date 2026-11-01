# PAK metadata probe: supported contract

28 October 2026. Format authority: the serializers and reader in upstream BlurRebuilt commit `5270304b81983b9e3edbd569ba25235c17bbabd7`. This small independently structured reader reads metadata only. It is not the game engine and does not decode payloads, verify hashes/signatures, draw assets, or establish source-file authenticity.

## Source evidence

- `code/mercury/library/util/logicalFs/include/pakfs/impl/PakHeader.h`: V1/V2 headers and V2 FAT layout.
- `.../include/pakfs/impl/PakFatEntry.h`: 32-byte normal V1 entries, 56-byte secure V1 entries, directory sentinel and parent offset.
- `.../include/pakfs/impl/PakDefinitions.h`: magic, maximum 32 KiB sector size, version range, FAT and codec identifiers.
- `.../source/pakfs/impl/PakRead.cpp`: endian detection, header/table positions, V2 40/64-byte on-disk entries, string padding and parent stride conversion.
- `.../source/pakfs/impl/PakUtil.cpp`: normal string-table XOR representation. The probe uses that representation to decode names; it does not alter hash or signature checks or claim to have performed them.

## Byte contract

- Bytes 0–11: magic, U32 version and U32 sector size. Retail PC magic bytes are `2KAP` (little endian); `PAK2` selects big endian.
- U32 serialized header size at byte 12, then header. V1 header is 40 bytes including a 20-byte integrity hash. V2 header is 32 bytes without that hash.
- V2 settings: codec, FAT type, path separator, unused byte; U32 flags and metadata-string offset; U64 timestamp; U32 string-table block size, FAT block size and unknown field.
- V2 string table starts at sector 1. U32 string byte count is followed by encoded string bytes and padding. FAT starts at sector size + declared string-block size. Blocks must be sector-aligned.
- V1 string table follows its header. FAT starts after the padding consumed by upstream `ReadStringTable`. That reader consumes one whole sector even when the preceding position is already aligned; the probe preserves that behavior.
- FAT begins with U32 entry count and U32 entry byte size. Normal entry stride is 32 (V1) or 40 (V2); secure entries add 24 bytes.
- Common entry prefix: U32 path CRC, U32 string offset, U32 parent FAT byte offset, U32 logical byte length, U64 timestamp, U64 data-start sector. V2 adds U32 unknown and U32 physical payload byte length.
- Directory data-start sentinel is U64 maximum. No-parent sentinel is U32 maximum. Paths are full names as stored, not rebuilt from parent chains.
- Secure-entry hashes are present in the table but **not verified**. Unknown V2 values are not interpreted. V1 physical lengths require reading per-payload headers and are returned as null.

## C ABI and browser loading

```c
char* pak_inspect(const unsigned char* prefix, size_t prefix_length, double file_size);
void pak_free(void* result);
```

The return value is a malloc-owned UTF-8 JSON string; free it using `pak_free`. A null return means allocation failure. Compile with C++17 and exception catching enabled (`-fexceptions` for Emscripten). All exceptions are contained at the ABI boundary.

- `status: "need_more"`, `requiredBytes`: request a larger prefix from the same file. Read `File.slice(0, requiredBytes)`, then call again with the original total file size. This does not read/decompress payloads.
- `status: "error"`, `error`: unsupported/invalid input or a probe resource limit. Do not present partial entries as successful results.
- `status: "ok"`, `header`, `entries`, `validationPerformed: false`, `payloadDecoded: false`.

Header keys: `version`, `sectorSize`, `codec`, `codecName`, `codecFlags`, `fatEntryType`, `fileCount`, `stringTableBytes`, `metadataBytes`, `fileBytes`, `endian`. `fileCount` includes directory FAT entries. `metadataBytes` is the end of actual FAT records; a requested prefix may also contain block padding.

Entry keys: `index`, `path`, `pathCrc`, `isDirectory`, `logicalBytes`, `physicalBytes`, `dataOffset`, `parentIndex`. Directory data offset is null; physical length is null for directories and V1 entries. Bytes outside ASCII are escaped as JSON U+00XX; encoding beyond the observed PC ASCII names is not inferred.

Limits: file size must be a nonnegative JavaScript-safe integer, metadata at most 64 MiB, count at most 100,000 entries, path length at most 4 KiB and total returned path data at most 16 MiB. These are deliberate probe limits, not asserted format limits. Input prefix cannot exceed file size. Header/block/FAT/string/payload ranges and integer multiplication are checked before use.

Codec identifiers 1–5 are reported as raw, zlib, xmem, packet-zlib and packet-xmem. Knowing a codec name does not mean this probe supports decompressing it.

## Local native verification

MSVC x64 Release build succeeded. Tests passed for V1/V2 × normal/secure FAT × both endians (8 synthetic valid cases), two staged-prefix requests and 16 invalid/truncated inputs. Tests explicitly fail using exceptions rather than disabled Release `assert` macros.

The CLI read all seven installed PC cache packages without reading full payloads:

| File | Version | Codec | FAT entries |
|---|---:|---|---:|
| boot.pak | 2 | packet-zlib | 931 |
| gamedata.pak | 2 | zlib | 621 |
| gamedata_boot.pak | 2 | zlib | 80 |
| lut_rampak.pak | 2 | packet-zlib | 218 |
| root.pak | 2 | packet-zlib | 3,601 |
| root_streaming.pak | 2 | raw | 68 |
| shaders-speed.pak | 1 | zlib | 1,256 |

Reports were written under `_work/verification/pak-reader/`. These are local test outputs, not redistributable game payloads. Native success alone does not establish WASM parity or browser behavior; the parent task runs those checks independently.
