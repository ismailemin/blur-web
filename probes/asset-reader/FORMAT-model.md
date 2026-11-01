# Decoded PC model header inspector

`model_inspect(bytes, available)` accepts one complete, already decompressed model payload. It returns malloc-owned UTF-8 JSON, released with `model_free`. Null return means allocation failed. This C++17 module has no game-engine, zlib, GPU, file-system or platform-runtime dependency.

## Observed format authority

Source reference: Blur Rebuilt commit `5270304b81983b9e3edbd569ba25235c17bbabd7`.

- `code/mercury/library/common/system/include/system/misc/Platform.h` defines PC fourcc `'PC  '`. Little-endian PC files store bytes `20 20 43 50` (`  CP`). Other platform/endian values are explicitly unsupported here.
- `code/mercury/library/common/system/include/system/serialise/C_FileBlock.h`: 8-byte identifier, U32 header-inclusive byte size, U16 child count, S8 type, S8 compression. Identifiers are null-terminated; source constructors limit names to seven characters.
- `code/mercury/library/common/system/source/serialise/C_FileBlock.cpp`: container child headers and boundaries are owned by the file-block layer.
- `code/mercury/library/gamesys/game_resource/source/ModelResource.cpp::LoadModelData`: after platform validation, expects `Model`; `Header`, `MdlDat`, `Render`, `Coll` are dispatched to their respective readers.

Types `0x43` (container) and `0x41` (data) are recognized. Only container payloads are traversed according to their declared child count, requiring children to fill the container. Data payloads remain opaque, regardless of resembling nested headers. Compressed containers are explicitly rejected; data compression is only reported, not decoded by this module.

## Bounds and limits

- Maximum input: 64 MiB.
- Maximum root-to-leaf depth: 32, with a top-level chunk at depth 1.
- Maximum total chunks across all roots: 100,000.
- Every header and byte size must fit its parent/input. Header-inclusive size must be at least 16.
- First top-level chunk must be a `Model` container. Remaining top-level chunks, such as `MtaDbg`, are also inspected with identical limits.
- ASCII printable identifier validation prevents control bytes and unterminated identifiers from entering the result.
- `integrityValidated:false` is emitted on success and error. No payload hashes, signatures, model semantics, vertex layouts or rendering are validated.

## JSON

Successful shape:

```json
{
  "status": "ok",
  "platform": "PC",
  "integrityValidated": false,
  "inputBytes": 8015,
  "chunks": [
    {"id":"Model","offset":4,"bytes":7676,"count":4,"type":67,"compression":0,"children":[]}
  ],
  "chunkCount": 6
}
```

The abbreviated `children` above is only a shape example; the actual result contains the four header records. Errors return `status:"error"`, `integrityValidated:false`, and `message`.

## Real local comparison fixture

`_work/model-probe/trafficcylinder.model` was decoded from this retail `root.pak` entry, outside versioned source:

- Path: `\models\objects\usa_la_river\misc\trafficcylinder.model`.
- Physical offset 261,296,128; stored 3,424 bytes; decoded 8,015 bytes.
- Source record: `_work/model-probe/trafficcylinder.source.json`.
- Decoded SHA-256 identity: `57f28fb4026a638c2a93469148b8597ebf93ac79c22acd3c836d58e32fc1565b`. This is a local comparison value, not authenticity proof.
- Expected top-level chunks: Model at offset4/bytes7676 and MtaDbg at offset7680/bytes335.
- Model children: Header20/20, MdlDat40/610, Render650/6510, Coll7160/520 (offset/bytes).

`model_cli.cpp` reads only files up to 64 MiB, prints JSON and exits 0 only for success. Synthetic tests exercise truncated bounds, invalid size/type/platform/id, count mismatch, depth boundary/overflow, total count cap, input cap and opaque data behavior. Native/WASM build and comparison results are recorded by the main agent.
