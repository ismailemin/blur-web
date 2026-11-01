# Local bounded model corpus

`tools/prepare_model_corpus.py` prepares local test inputs from the installed
`game-data/Blur/cache/root.pak`. It reads game files, decompresses bounded payloads,
and writes fixtures below ignored `_work/model-corpus/`; it never executes a game
binary or changes the installed data or upstream checkout.

Run from the workspace root:

```powershell
python tools/prepare_model_corpus.py
```

Use the bundled Python executable if `python` is a Store alias. `--limit` accepts
1..30; the default is 30. `--game-dir` and `--out-dir` can be set explicitly, but
output inside the game directory is rejected.

## Selection and evidence

The retail root index contains **326 eligible models** with logical size at most
65,536 bytes and physical size at most 65,544 bytes. Selection is deterministic:
the known river traffic cylinder first, then the smallest inputs, then a round
robin across sorted parent directories (each directory ordered by size and path).
The default selection produces **28 accepted fixtures** totaling **768,683 decoded
bytes** and two explicit unsupported-format rejections.

`_work/model-corpus/manifest.json` records each fixture's filename, source PAK
offset and record, decoded SHA-256, chunk tree, and inner Render/Scene envelope.
These hashes identify local comparison bytes; they do not authenticate retail
provenance. The files contain original game data and remain outside Git.

Verification recorded in `_work/model-corpus/verification.json`:

- Repeated preparation produces an identical manifest.
- All 28 fixture hashes match the manifest.
- All 28 generic model chunk trees exactly match the independently implemented
  native `model_inspect.exe` JSON, including offsets and boundaries.
- Six malformed/truncated packet/model inputs are rejected.

Packet decoding uses raw DEFLATE with a maximum output of logical size plus one;
exact output length, EOF, trailing data and unconsumed compressed input are checked.
A full raw packet uses the source sentinel `0xffffffff` and must contain exactly
65,536 stored bytes. This tool deliberately supports one packet only; it does not
silently apply that rule to larger models.

The two rejections are **not failed decompression**. Their bytes begin directly
with `Model`, without the four-byte PC platform marker required by the current
inspector:

| Source entry | Decoded bytes | First bytes |
| --- | ---: | --- |
| `\models\specialfx\start_finish_dust.model` | 6,990 | `4d6f64656c0000004e1b000004004300` |
| `\models\objects\shared\uk\greybox1.model` | 48,889 | `4d6f64656c000000f9be000004004300` |

They are recorded with the reason `Not a little-endian PC model`; this describes
the accepted format restriction and does not establish that the asset is corrupt
or belongs to another platform.

## Archive envelopes and type information

Source authority is `upstream/BlurRebuilt` commit
`5270304b81983b9e3edbd569ba25235c17bbabd7`.

`graphics/world_render/source/RenderModel.cpp::C_RenderModel::Read` constructs an
inner `Render` C_FileBlock inside the model's opaque Render payload, and dispatches
its `Scene` child to `WorldRender::ReadScene`. The corpus tool follows those exact
declared boundaries; it does not scan for plausible `ARCH` bytes.

`common/misc_shared/include/misc_shared/archive/binaryarchive.h` defines the outer
`ARCH` version/endian envelope, the inner archive version, class marker/version,
and string encoding. `graphics/world_render/source/WorldRender.cpp::ReadScene`
reads its S32 format version before Target::Scene. All 28 accepted models have:

| Field | Observed value |
| --- | ---: |
| Outer ARCH version | 1 |
| Endian swap flag | 0 |
| Inner ARCH version | 0 |
| World ReadScene format version | 1 |
| Target Scene class version | 0 or 1 |

The two seatbelt models use Target Scene class version 0; the other 26 use 1.
`render.archive.origin` is the alignment origin for serialized buffers and must
be used instead of file offset zero.

The on-disk `RA` marker identifies a versioned object boundary, **not its class
type**. `archive/pointer.h` writes a SerialisationType byte and, for polymorphic
pointers, a full registered identifier string (U32 length followed by bytes).
The source explicitly avoids assuming stable numeric class keys across builds.
Relevant registered identifiers in
`graphics/renderingdata/include/renderingdata/noninterface/archive.inl` are:

| Identifier | Registered class version |
| --- | ---: |
| `RenderingData::Node` | 0 |
| `RenderingData::RootNode` | 0 |
| `RenderingData::CullNode` | 2 |
| `RenderingData::GroupNode` | 0 |
| `RenderingData::LodNode` | 0 |
| `RenderingData::MaterialNode` | 0 |
| `RenderingData::RenderNode` | 0 |
| `RenderingData::RenderListNode` | 4 |

Target `archive.cpp` separately registers
`RenderingData::RenderListNode_Common` version 0. That exact identifier occurs in
the traffic-cylinder fixture. A general reader must distinguish the target
wrapper from the base RenderListNode serializer and its class version. Substring
searches for `RenderingData::RenderListNode` also match the longer Common name
and are not proof of an additional node.

## Useful next fixtures

| Local filename | Decoded bytes | Render bytes | Purpose |
| --- | ---: | ---: | --- |
| `00-trafficcylinder-57f28fb4.model` | 8,015 | 6,510 | Known 100 vertex/114 triangle baseline |
| `01-spiralfirework-d024d418.model` | 1,682 | 891 | Small scene; CullNode strings, no RenderListNode identifier observed |
| `02-docksshiplights-eafb5270.model` | 2,262 | 891 | Another small scene traversal baseline |
| `04-blue_laser_01-2485faf2.model` | 9,609 | 8,361 | Small rendered scene, one Common identifier observed |
| `07-trafficcylinder-9bbf2ad7.model` | 10,337 | 8,832 | Downtown cylinder, separate data from known river fixture |
| `09-igm_seatbeltfm_ml-3da54c2f.model` | 14,230 | 13,163 | Target Scene version 0 case |
| `10-igm_seatbelt_ml-efaeec96.model` | 14,230 | 13,163 | Second version 0 case |
| `26-bollard-693e0157.model` | 13,138 | 10,240 | Small environment model beyond cylinder |

Identifier string observations above are diagnostics, not a substitute for
sequential archive traversal. The corpus tool does not decode vertex buffers,
materials, node graphs, or transforms. Geometry counts are only claimed for the
separately verified baseline cylinder. Larger models, scene instances, cars,
tracks, materials and gameplay require further implementation.
