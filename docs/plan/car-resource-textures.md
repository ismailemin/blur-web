# Corvette resource texture payloads and original mip tails

The remaining12 static ordinary-albedo draws resolve to two images, rather than twelve different files. The independent diagnostic `tools/inspect_car_resource_textures.py` freshly traverses the actual model's seven resource blocks to the exact Scene boundary using the source-shaped material reader. It cross-checks the existing material report's model identity, texture names and draw assignments. No C++, web, upstream or game file is modified.

Input: `_work/car-level-assets/corvette_c3_race.model.decoded`, SHA-256 `77840511e5ca416ff9e7cbdc9ee9fc960fce0205f83c9be77e0803607c32cb9d`. All offsets below are absolute byte offsets within these decoded model bytes, supplied as evidence rather than runtime constants.

| Image | Source | Draws | Smallest complete descriptor | Header offset | Payload offset / bytes |
| --- | --- | --- | --- | ---: | --- |
| `corvetterace_dials` | block2, texture0 | 21,79 | LOD0,16×16,5mips,BC3 | 2051139 | 2051185 /368 |
| `corvetterace_interior` | block6, texture0 | 6,15–20,61,65,66 | LOD0,16×16,5mips,BC1 | 2950530 | 2950577 /184 |

Both headers are the original28-byte PC `Display::TextureDesc`, in field order Width, Height, Depth, Levels, Format, Usage, Type. Depth1/type3 identify 2D textures. Descriptor and payload are separated by the archive buffer envelope and source-relative alignment. Taking one contiguous slice starting at the descriptor would incorrectly include that envelope as texels.

## What later resource LODs contain

Source `graphics/renderingdata/source/noninterface/target/archive.cpp:830` reads name/sampler/hash only at LOD0. Every populated subsequent LOD supplies a new original descriptor and an archive buffer. `present=0` supplies neither, and therefore leaves the prior available texture as the stream fallback; it is not a zero image. `present>1` indicates paired texture source references, explicitly rejected by this bounded assembler.

On PC, `Display::LoadTextureData2D` consumes an exact prefix of complete mip payloads, starting at the descriptor's largest mip. `Display::CopyTextureData2D` aligns the existing mip tail by the difference in mip counts. Source authority: `graphics/display/source/texture/d3d11/D3D11TextureLoad.cpp:90` and `:149`. For these two images, each populated later LOD adds exactly one new largest mip. The newly supplied bytes precede the previously assembled complete tail. All original descriptor bytes remain unchanged.

| Image | Source resource LOD | Dimensions | New payload bytes | Complete mip-chain bytes |
| --- | ---: | --- | ---: | ---: |
| dials | 0 | 16×16 | 368 | 368 |
| dials | 7 | 32×32 | 1024 | 1392 |
| dials | 8 | 64×64 | 4096 | 5488 |
| dials | 9 | 128×128 | 16384 | 21872 |
| interior | 0 | 16×16 | 184 | 184 |
| interior | 3 | 32×32 | 512 | 696 |
| interior | 4 | 64×64 | 2048 | 2744 |
| interior | 5 | 128×128 | 8192 | 10936 |
| interior | 6 | 256×256 | 32768 | 43704 |
| interior | 7 | 512×512 | 131072 | 174776 |

BC1 byte counts use `max(1,ceil(w/4))*max(1,ceil(h/4))*8`; BC3 uses16 bytes per block. The1×1 and2×2 tail mips still occupy one complete block each. Before copying a tail, the assembler verifies format, dimensions, mip counts, exact payload prefix boundaries and absence of gaps/overlap. It never relabels a top-mip-only payload with an invented one-level descriptor.

## Reproduction and results

```powershell
python tools/inspect_car_resource_textures.py
```

Use the installed bundled Python when the PATH `python` resolves to the Store alias. The script writes only `_work/car-resource-textures/`: report, original-descriptor-plus-complete-chain `.rawtexture` files, independent Pillow RGBA bytes and PNGs for all10 populated LODs. The report records every descriptor hash, original byte range, copied tail hash and final image hash. All10 files were accepted by the current native `texture_inspect.exe --raw` decoder. Interior BC1 pixels matched Pillow byte-for-byte for all6 sizes. Dials BC3 RGB matched byte-for-byte;53/104/353/822 alpha channels respectively differ by exactly1 because the source decoder rounds BC3 alpha interpolation and Pillow floors it. This is the already documented BC3 difference, rather than a mip assembly discrepancy.

The diagnostic also rejected26 invalid assembly cases: incomplete mip payloads, missing prior tails and incompatible tail dimensions. A repeated run produced a byte-identical report, SHA-256 `da62c6e8fa49fb3b0a483bf15b593e5aea9c9c9e576fb516234bc9f4485cd931`. The fresh traversal and report do not claim full original shader, alpha blend, runtime lighting or paint reproduction.

| Original descriptor + complete chain | SHA-256 |
| --- | --- |
| dials LOD0,396bytes | `28246c72e5e3988646fb82f70298f23ead97c76badb5f6e4f4dfe9f4b1cfa543` |
| interior LOD0,212bytes | `9218e62e538d6c319fc7534c07a5396e78914d3b484eb7c1d7bbfc695a498418` |
| dials LOD9,21900bytes | `e8e3f7858901634ad5bb205adc0115ac9ba6b91f7d1d040506bd67bbfc2b8069` |
| interior LOD7,174804bytes | `32ebfd1b566370766315f6c5543b5bb24a5725cf78580fe71946b63ba4048898` |

## Bounded browser integration

The smallest faithful implementation can expose the two complete LOD0 images before implementing streaming quality upgrades. A separate bounded C ABI such as `scene_resource_textures_inspect(modelPtr, modelBytes)` should walk the original model resource blocks and return metadata only: `(block,index)`, original name/hash/sampler, source LOD number, descriptor offset/length and payload offset/length. The first RenderList's material resolver should retain its resource-block texture identity rather than replacing it with a guessed shared index. Runtime offsets must come from parsed source structures; the fixture offsets above are verification expectations only.

The current Scene reader stops after the first RenderList's source lists. Continuing requires its remaining ChunkData traversal, subsequent node types, all resource LOD records and later resource blocks; `MaterialReader.node`, `render_list`, `resource_blocks`, `texture_lod` in the independent diagnostic already show the source order. Unknown nodes, compression, paired source references and unsupported shapes must fail explicitly in the metadata path, without breaking the existing geometry preview.

No new pixel-decoder ABI is required for the first LOD0 integration. The browser can concatenate the original28 descriptor bytes and exact complete texel slice into a small temporary buffer, then call existing `texture_raw_inspect`. This preserves the original descriptor, avoids exposing archive envelope bytes, and changes neither format nor mip count. A two-span descriptor/data ABI is optional if temporary copying later matters. Map the decoded texture to the original `(block,index)` for the12 supported draws and keep their independently verified UV0. Together with the existing14 shared-image draws, this would resolve all26 static ordinary-albedo inputs; runtime paint and light blends would remain unimplemented.

For higher quality, metadata must return every populated LOD's descriptor and new payload spans, preserving absent-LOD fallback. Build complete chains by matching source tail dimensions/levels, or upload each original compressed mip into its matching WebGPU subresource. A later top-mip-only payload must never be sent alone to the existing complete-chain decoder. Compare native/WASM image output and exact original slice hashes against this diagnostic before claiming that quality path is supported.
