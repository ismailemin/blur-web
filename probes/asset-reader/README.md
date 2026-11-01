# Blur PAK / model WebAssembly probe

Executable browser port components: portable asset readers and a WebGPU model preview. This is not yet a playable game.

## What works

- Portable C++17 PAK metadata reader compiled for Windows x64 and wasm32.
- V1/V2, little/big endian, regular/secure FAT metadata; incremental prefix requests with 64 MiB limits.
- Browser UI reads an incremental PAK index, filters records and inspects supported models, textures and XT schemas.
- Packet-zlib assets up to16MiB are decoded with bounded browser raw-DEFLATE streams; raw and ordinary zlib support is used for XT fixtures. Model block headers and payload subsets are parsed in WASM. Windows platform code, Gravity and DX11 are not linked into this module.
- Native tests, native/WASM comparisons on all seven installed cache PAK files, and independent Python reference comparison for six V2 PAKs.
- Bounded multi-packet raw-DEFLATE/raw-block decoding up to16MiB; three real larger models (2,4,30packets) match independent Python bytes.
- Source-shaped sequential ARCH Scene traversal, without fixed offsets or fixture SHA selection, previews first resource block/first render list/LOD0 base geometry. Native/WASM results match on28models;26supported,2explicitly unsupported. Original UV0 and embedded texture ranges are recovered. See `FORMAT-scene.md`.
- Real Corvette body:30,591vertices,36,193triangles,80draws. F16_4 POSITION0 and source-selected streams/byte offsets match independent Python geometry. Four original shared albedo images bind14draws using original UVs; missing UVs cannot bind textures. Vehicle paint,12external image draws, damage and wheel placement are pending; lighting remains diagnostic.
- Original levelrender Scene/ChunkInfo indexes plus separate geometry/node levelstream ranges are decoded without fake model wrappers. River's broader subset has17,782vertices/9,343triangles/95draws; showroom has11,590vertices/7,987triangles/95draws. Three larger River pairs and showroom match independent Python geometry and native/WASM JSON. The first344vertex/208triangle fixture remains a regression check. Instances, other blocks, materials and visibility are explicitly omitted. The HTTP server exposes bounded ranges from three whitelisted levels.
- PC FLSK v1/v2 XT schema/type/field/record metadata. Three real actor packs match independent Python. No runtime objects or reflection fixups are created; see `FORMAT-xt.md`.
- Real PC `.texture` and embedded TextureDesc+texels decode toRGBA: BC1,BC2,BC3 and selected uncompressed formats,2D<=512×512. Original XT files contain game/UI data, not textures. See `FORMAT-texture.md`.
- Actual model geometry renders through WebGPU, with surface/wire view and orbit/zoom controls. Diagnostic lighting remains separate from original shader fidelity.

No payload signatures or authenticity checks are performed. Secure-FAT indexing does not imply successful signature validation. Full XT import, complete Scene traversal/instances/world transforms, original effects, physics and multiplayer are pending. The original SHA-gated mesh reader remains an independent first-fixture diagnostic; the browser prefers the sequential Scene reader. See `FORMAT.md` and `FORMAT-model.md` for the remaining source references/restrictions.

## Build

Requires Visual Studio 2022 C++ build tools + Windows SDK + CMake, Python 3.12+, and Emscripten **6.0.13** installed/activated at `_work/toolchains/emsdk`. No global PATH change is required.

To rebuild fixtures, compile native/WASM readers and run all comparisons from the workspace root:

```powershell
python tools/verify_asset_probe.py
python tools/serve_asset_probe.py
```

Use the actual bundled Python path if `python` is a Windows Store alias:
`C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe`.

`verify_model_wasm.mjs` expects the independently decoded comparison fixture at `_work/model-probe/trafficcylinder.model`; regenerate it with `python tools/prepare_model_fixture.py` if missing. It is not shipped in this repo. For a wider read-only inventory use `python tools/inspect_asset_layout.py --game-dir game-data/Blur --out _work/asset-layout/retail-layout.json`.

Open **http://127.0.0.1:8765/**. Choose a `.pak` file, or load an installed reference package. To inspect the verified model, open `root.pak`, filter `trafficcylinder`, then select **Blokları oku** on the `usa_la_river` entry.

For the actual car body, filter `corvette_c3_race.model` in root.pak and select the body row outside `wheels/`. For XT metadata, choose gamedata.pak and filter `vehicletestscene\actorpack.xt`. Choose River (wide/small) or Showroom and click **Sahne parçasını aç** to load original levelrender metadata and two selected stream ranges using offsets from the WASM index.

The loopback server serves only the web folder and bounded ranges from an explicit whitelist of installed PAK files. It does not execute game binaries or modify the source/game data. Browser-generated `.mjs/.wasm` and all game/fixture data are ignored by Git.

## Verification evidence

- `_work/verification/pak-native-wasm.json`
- `_work/verification/pak-reference-comparison.json`
- `_work/verification/model-native-wasm.json`
- `_work/verification/mesh-native-wasm.json`
- `_work/verification/scene-native-wasm.json`
- `_work/verification/texture-native-wasm.json`
- `_work/verification/packet-reference.json`
- `_work/verification/car-native-wasm.json`
- `_work/verification/xt-native-wasm.json`
- `_work/verification/level-native-wasm.json`
- `_work/verification/level-candidates-native-wasm.json`

The SHA-256 of the independently decoded traffic-cylinder model is recorded for reproducibility, not as proof of original retail provenance. Scene preview success covers only the explicitly reported geometry subset, not complete original scene behavior.
