# Bounded PC .texture decoder

`.xt` is compiled XT game/UI data, **not** the texture format. This decoder reads original `.texture` files after the PAK packet has been decompressed. No platform marker is present before this container.

## Source authority

Paths below are relative to `upstream/BlurRebuilt` at commit `5270304b81983b9e3edbd569ba25235c17bbabd7`:

- `code/mercury/library/graphics/display/source/texture/TextureUtils.cpp`, `LoadTexture`: outer `Texture` C_FileBlock; Header version U32 and flags U32; Data passed to LoadTexture2D.
- `code/mercury/library/graphics/display/include/display/texture/TextureDesc.h`: seven serialized 32-bit fields in order Width, Height, Depth, Levels, Format, Usage, Type.
- `code/mercury/library/graphics/texture_export/source/targets/pctex.cpp`, `SerialOutTexture`: descriptor and sequential mip texels, largest mip first. 2D type3, cubemap5, volume4 (only type3 supported here). Usage is serialized by exporter but appears uninitialized there; it is retained as uninterpreted metadata, never treated as a structural invariant.
- `code/mercury/library/graphics/display/source/texture/d3d11/D3D11TextureLoad.cpp`: current runtime's equivalent PC mip layout; each BC1 mip uses ceil(w/4)*ceil(h/4)*8 bytes, BC2/3 use16.
- `code/mercury/library/common/system/source/serialise/C_FileBlock.cpp`: header-inclusive block lengths and child traversal.
- `code/mercury/library/graphics/display/source/device/d3d11/D3D11Formats.cpp`: D3DFORMAT to channel layouts.

Standard BC pixel rules: [Microsoft BC1](https://learn.microsoft.com/en-us/windows/uwp/graphics-concepts/opaque-and-1-bit-alpha-textures), [Microsoft BC2/BC3](https://learn.microsoft.com/en-us/windows/uwp/graphics-concepts/textures-with-alpha-channels). BC3 alpha interpolation uses Microsoft's rounded integer examples (+3 before /7, +2 before /5). This is a diagnostic CPU decoder; original material color transforms, sRGB interpretation and alpha blending are not applied.

## Accepted exact layout

Little-endian container starts at byte0. It has exactly two children in Header/Data order, uncompressed blocks, matching header-inclusive lengths and counts. Header version0 only.

| Offset | Meaning |
| --- | --- |
| 0 | 16-byte `Texture` container header, count2, type0x43 |
| 16 | 16-byte `Header` data-block header, total24bytes |
| 32 | version U32=0 |
| 36 | flags U32 |
| 40 | 16-byte `Data` data-block header |
| 56 | 28-byte TextureDesc |
| 84 | mip0 texels followed by remaining mip chain |

Input84bytes..8MiB, dimensions1..512, depth1/type3, mip count1..floor(log2(max(width,height)))+1 (at most10). Every declared mip contributes to the exact Data byte count; only mip0 is converted. BC edge blocks are cropped to the logical dimensions. Unknown formats, cube/volume, compressed FileBlocks, other versions, extra children/trailing bytes, impossible mips and truncation return explicit errors.

Supported D3DFORMAT: DXT1(BC1), DXT3(BC2), DXT5(BC3),21A8R8G8B8,22X8R8G8B8,32A8B8G8R8,33X8B8G8R8,28A8,50L8. A8 preview uses white RGB with source alpha; L8 replicates luminance to RGB. DXT2/4 premultiplied variants and other formats are rejected.

API `texture_inspect(ptr,size)` returns malloc-owned JSON `{status,width,height,rgba,metadata}`. `rgba` is flat row-major 8-bit RGBA, no vertical flip. `texture_free` releases the output. Metadata states no integrity validation/color transform; decoding is structural format interpretation, not provenance verification.

`texture_raw_inspect(ptr,size)` accepts embedded PC TextureDesc+complete mip texels directly, without any FileBlock headers. Bounds are28bytes..8MiB, otherwise the same dimensions/type/mip/format validation applies. Its metadata.container is `PC embedded texture`, pixelDataOffset28, and flags are omitted because embedded payloads contain no standalone flags field. Real trafficcylinder embedded BC1(16x128,8mips) output exactly matches independent Pillow RGBA bytes; see `docs/plan/material-binding.md` for the proven source-material binding.

## Real fixtures and evidence

`tools/prepare_texture_fixture.py` reads only an indexed, bounded regular packet-zlib entry from local root/boot PAK. Its default arrow fixture is root.pak `\graphics\textures\specialfx\arrow.texture`:1644packed ->11020decoded bytes,128x128 BC1,8mips. Decoded SHA256 `6d99adb87622291323c7144285d4b79589f6216417a53d45f132e3db2412c6b1`.

The preparer also wraps source texels in a standard DDS header and decodes with independent Pillow12.3.0, retaining RGBA/PNG locally. Native C++ arrow RGBA exactly equals all65536 Pillow bytes, SHA256 `a29bc13ee98386bf20899295d54c7ecc47e5cc9c29cd69034a88ae9d8f916462`. A second BC2 fixture (`\dontship\textures\debugframe.texture`,64x64) also matches every pixel byte, SHA256 `0b383281b596dac2a853ac5399abdeb21872e9083422a11264ad4f3b64b0d285`.

For real BC3 `\graphics\textures\particles\splash01.texture` (128x128), RGB matches exactly;2194 alpha components differ by+1 because Pillow floors interpolation while the Microsoft example rounds. Maximum difference is1/255, all other channels exact. Native C++ RGBA SHA256 `6b9247bbe2967c076b7ef6e553782112af77ded64008e0cc1ab052500c124468`. This is a recorded rounding-policy difference, not byte equality. Known-value tests exercise both BC3 interpolation modes and implicit alpha0/255.

Fixtures and original pixels remain under ignored `_work/texture-probe`; no game data is committed or copied into the web source tree.
