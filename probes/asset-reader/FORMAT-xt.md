# PC FLSK / compiled XT metadata reader

`xt_inspect(decodedBytes, size)` / `xt_free(result)` is a portable C++17 metadata
reader for compiled little-endian PC FLSK v1/v2. Success validates header/table
bounds, schema references and record/component/data extents. It creates no game
reflection objects and does not interpret or follow payload pointers, handles,
arrays, runtime layouts or actor state. It is not a full XT importer.

No native C++ struct is cast over input bytes. Every integer is read at its
source-defined serialized width. In particular, `XtId` is U32 even in the x64
Rebuilt source; the serialized data does not use native pointer-sized fields.

## Fixed layout and source authority

`code/mercury/library/common/xt2/source/common/XtFlask.h` defines:

| Structure | Serialized bytes | Fields |
| --- | ---: | --- |
| FlaskHeader | 72 | U32 tag/version, eight `(U32 offset,U32 count)` blobs |
| FlaskType | 12 | U16 name,fieldCount,baseCount,behaviour,atom,size |
| FlaskBase | 4 | U16 type,offset |
| FlaskField | 8 | U16 name,type,offset; U8 behaviour,array |
| FlaskRef | 8 | U32 id; U16 type,record |
| FlaskRecord | 16 | U32 ref,componentCount,dataBytes,stringBytes |
| FlaskComponent | 6 | U16 type,count,behaviour |
| FlaskArray | 8 | U16 component,element; U32 length |
| FlaskPtr / FlaskHandle | 4 | U16 component,element / U32 id |

All eight blob offsets must align to4 bytes. Counts multiply the listed row
width, rather than indicating byte lengths for typed tables. The schema string
and data tables use byte counts. Empty tables may share an aligned offset.
Nonempty tables may not overlap the header or each other in this bounded reader.
The retail compiler's normal layout satisfies this additional restriction.

Header tag is the source multicharacter U32 `'FLSK'` = `0x464c534b`, which appears
as **`KSLF` bytes on disk** in little-endian PC files. Other tags/endianness and
versions are explicitly rejected. The `.xt` suffix alone is not sufficient to
select this reader; XML or other XT formats remain unsupported.

`XtFlaskImport.cpp::ValidateFlask` supplies the schema/index checks:

- Type behaviour0 atom,1 enum,2 flags,3 struct; atoms use IDs1..14 and have no
  fields; non-atoms use atom0; only structs can have bases.
- Base type references must select structs whose serialized extents fit the
  containing type. Per-type base/field counts consume those tables exactly.
- Enum/flag labels use typeFFFF, offset0, behaviour6, array0. Struct field
  behaviours0..5 must agree with the referenced atom/enum/flags/struct type.
- Struct fields fit using the serialized target size, FlaskArray8, or
  pointer/handle4. The reader does not substitute x64 runtime sizes.
- Refs have strictly increasing nonzero U32 IDs, in-range type indices and
  either recordFFFF (external/unloaded) or an in-range record index.
- Each record names a valid ref and nonempty component range. Components have
  valid type and behaviour0 object /1 pointer /2 handle. Their serialized
  byte lengths accumulate with4-byte alignment and must equal record.dataBytes.
  Record data plus string bytes consume the data blob exactly; all components
  are accounted for.

`XtFlask.cpp` supplies the v2 schema string transform: previous byte startsCC,
decoded = previous - (encoded XOR B3), modulo256; previous advances by decoded
minus character index. As in the source, the final byte is set toNUL. V1 schema
strings are copied unchanged. Referenced names must terminate inside the schema
string blob; this initial module supports printable ASCII names up to4096 bytes.
Record-local strings inside the data blob are not decoded.

## API output and limits

Returned malloc-owned JSON has `status:"ok"`, format/version/endian/inputBytes,
`tables`, `types`, `fields` and `records`. Type rows include schema names,
serialized size, behaviour/atom and base/field ranges. Field rows include name,
type index (`null` for a label), serialized offset/behaviour and array flag.
Record rows expose ref ID/type, component range and bounded data/string extents.
Opaque record payload bytes are not emitted or interpreted.

Scope flags are explicit: `schemaBoundsValidated:true`,
`recordPayloadValidated:false`, `runtimeObjectsCreated:false`,
`integrityValidated:false`. Schema bounds checks do not establish graph
acyclicity, original provenance, full object validity or working gameplay.
Invalid/unsupported inputs return `status:"error"` and `error`; no partial
schema is returned. Release the result with `xt_free`.

Limits:64MiB input,4096 types,65535 bases/refs/records,100000 fields/components,
4MiB schema strings,4096-byte names and16MiB JSON. Repeated name expansion is
budgeted before constructing the output. Serialized payload pointer/array
indices and handle fixups are intentionally not imported or claimed validated.

## Real evidence and tests

`tools/prepare_xt_fixture.py` reads bounded ordinary zlib entries (PAK codec2,
`PakCompressZLib.cpp` uses `inflateInit`) from installed `gamedata.pak`, including
its known secure FAT metadata layout. It does not verify FAT signatures or
modify game files. Three local fixture/reference pairs are generated under
`_work/xt-probe/`:

| Actor pack | Decoded bytes | Types | Fields | Records |
| --- | ---: | ---: | ---: | ---: |
| vehicletestscene | 1228 | 19 | 31 | 1 |
| showroom | 4440 | 26 | 38 | 1 |
| global | 38784 | 91 | 129 | 8 |

Each source entry is `\gamedata\levels\<scene>\actorpack.xt` and all three are
FLSK v2. Manifest entries include source offsets, stored sizes and local SHA256
for reproducibility; these hashes are not retail authenticity assertions.
Independent Python table/schema/record diagnostics and native C++ JSON match
exactly for all three fixtures.

`xt_reader_tests` builds synthetic v1/v2 files from explicit integer fields,
checks every truncated prefix and invalid table alignment/overlap/count/offset,
type/field/base/ref/component/record/string bounds. Changing opaque record data
leaves metadata unchanged, demonstrating that no payload import is claimed.
An optional first argument points at the local1228-byte vehicle-test actor pack.

Source snapshot: unmodified upstream BlurRebuilt commit
`5270304b81983b9e3edbd569ba25235c17bbabd7`:

- `common/xt2/source/common/XtFlask.h`, `XtFlask.cpp`.
- `common/xt2/source/game/XtFlaskImport.cpp` (`ReadBlob`, `ValidateFlask`,
  `CreateSchema`); this module stops before runtime reflection import.
- `common/xt2/include/xt/XtCoreTypes.h` (U32 XtId).
- `common/xt2/include/xt/impl/XtReflection.h` (behaviour/atom enums).
- `common/xt2/source/tool/Export/XtFlaskEmit.cpp` (fixed-width atoms, arrays,
  pointers and handle export).
- `util/logicalFs/source/pakfs/impl/PakCompressZLib.cpp` (ordinary zlib wrapper).

Paths are relative to `upstream/BlurRebuilt/code/mercury/library/`.
