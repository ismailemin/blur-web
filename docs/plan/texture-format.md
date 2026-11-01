# Texture path for the browser port

The earlier XT/texture association was incorrect: XT is compiled game/UI data. Actual standalone texture payloads are `.texture` and use Display::LoadTexture with TextureDesc/PC texels. See `probes/asset-reader/FORMAT-texture.md` for source paths, field layout and restrictions.

Implemented portable decoder: `texture_reader.h/.cpp`, C ABI texture_inspect/texture_free. It converts mip0 from bounded PC2D containers to flat RGBA, with full mip-chain bounds checks. BC1/BC2/BC3 and selected uncompressed8/32-bit formats are supported; output dimensions capped512x512.

Root integration should add CMake static library/tests, WASM exports and the source to the standalone em++ build. Browser extraction can initially reuse the existing <=64KiB one-packet decoder and show a `.texture` row action. Read packed bytes from the user's local File/range source, call texture_inspect in WASM, copy RGBA to ImageData and show metadata. This provides the first genuine original texture preview without porting Direct3D.

Do not bind an arbitrary inspected texture to a mesh as if it were the original material. The current mesh proof has no decoded material/texture bindings or UV output. A proper textured mesh needs source-grounded material reference resolution, UV extraction, sampler semantics and color/alpha handling. Decoding and previewing a standalone texture is the completed bounded milestone.

Follow-on: texture resources embedded in ARCH scenes use related TextureDesc/PC payloads, but locating their offsets must come from source-grounded scene traversal. Do not scan for plausible dimensions or FourCC bytes.
