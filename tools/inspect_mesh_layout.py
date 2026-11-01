"""Read-only, identity-gated inspection of the first retail prop mesh.

This is an evidence tool for ONE decoded fixture, not a general scene parser.
Field order follows the RenderingData and Arch serializers in BlurRebuilt.
Offsets select known objects; every object is then consumed sequentially.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import struct

FIXTURE_SHA256 = "57f28fb4026a638c2a93469148b8597ebf93ac79c22acd3c836d58e32fc1565b"
FIXTURE_SIZE = 8015
SCENE_ORIGIN = 718


class Reader:
    def __init__(self, data: bytes, offset: int):
        self.data, self.offset = data, offset

    def unpack(self, fmt: str):
        result = struct.unpack_from("<" + fmt, self.data, self.offset)
        self.offset += struct.calcsize("<" + fmt)
        return result[0] if len(result) == 1 else result

    def marker(self, version: int):
        actual = self.unpack("2sH")
        if actual != (b"RA", version):
            raise ValueError(f"Unexpected class header at {self.offset - 4}: {actual!r}")

    def vector_count(self):
        self.marker(0)
        count = self.unpack("i")
        if count < 0 or count > 10000:
            raise ValueError(f"Invalid vector count {count}")
        return count

    def material(self):
        self.marker(0)
        return dict(zip(("index", "listIndex"), self.unpack("ii")))

    def blob(self):
        self.marker(0)
        size, alignment, compression, endian_swap = self.unpack("IIIB")
        if compression != 0 or endian_swap or alignment != 16:
            raise ValueError("Fixture expects uncompressed little-endian aligned data")
        relative = self.offset - SCENE_ORIGIN
        self.offset = SCENE_ORIGIN + (relative + alignment - 1) // alignment * alignment
        start = self.offset
        self.offset += size
        if self.offset > len(self.data):
            raise ValueError("Blob exceeds file bounds")
        return {"offset": start, "size": size, "alignment": alignment,
                "compression": compression, "endianSwap": endian_swap}


def inspect(data: bytes, include_geometry: bool = False):
    digest = hashlib.sha256(data).hexdigest()
    if len(data) != FIXTURE_SIZE or digest != FIXTURE_SHA256:
        raise ValueError("Unsupported fixture identity: expected decoded trafficcylinder.model")

    vb = Reader(data, 2731)
    vb.marker(1)
    vb.marker(0)  # VertexFormat
    stride = vb.unpack("i")
    elements = []
    for _ in range(vb.vector_count()):
        vb.marker(0)
        elements.append(dict(zip(("type", "method", "usage", "usageIndex"), vb.unpack("iiii"))))
    offsets = [vb.unpack("H") for _ in range(vb.vector_count())]
    vertex_count = vb.unpack("i")
    vertex_blob = vb.blob()
    expected_elements = [(6, 0, 0, 0), (11, 0, 3, 0), (8, 0, 5, 0)]
    if (stride, offsets, vertex_count) != (20, [0, 12, 16], 100):
        raise ValueError("Unsupported vertex format")
    if [tuple(e.values()) for e in elements] != expected_elements:
        raise ValueError("Unexpected vertex elements")
    if vertex_blob["size"] != vertex_count * stride:
        raise ValueError("Vertex buffer size mismatch")
    positions = [list(struct.unpack_from("<fff", data, vertex_blob["offset"] + i * stride))
                 for i in range(vertex_count)]
    if not all(math.isfinite(v) for p in positions for v in p):
        raise ValueError("Nonfinite vertex position")

    ib = Reader(data, 4855)
    ib.marker(1)
    index_count, index_type = ib.unpack("ii")
    index_blob = ib.blob()
    if (index_count, index_type, index_blob["size"]) != (202, 0, 404):
        raise ValueError("Unexpected index buffer")
    indices = list(struct.unpack_from(f"<{index_count}H", data, index_blob["offset"]))
    if max(indices) >= vertex_count:
        raise ValueError("Index exceeds vertex buffer")

    draws = []
    triangles = []
    for primitive_offset in (6094, 6238):
        ar = Reader(data, primitive_offset)
        ar.marker(1)
        effect, declaration, topology, buffer_index, flags = ar.unpack("iiiii")
        base_material, instance_material = ar.material(), ar.material()
        ar.marker(0)
        blend_state = dict(zip(("srcBlend", "destBlend", "blendOp", "alphaBlendEnable",
                               "alphaTestEnable", "alphaRef", "alphaToMaskEnable",
                               "cullMode", "zBias"), ar.unpack("iiiBBBBii")))
        lods = []
        for _ in range(ar.vector_count()):
            ar.marker(0)
            lods.append(dict(zip(("offset", "nIndices", "minIndex", "nVertices"), ar.unpack("iiii"))))
        streams = []
        for _ in range(ar.vector_count()):
            ar.marker(0)
            stream = dict(zip(("vertexBuffer", "streamIndex", "vertexOffset", "frequency"), ar.unpack("iiii")))
            stream["material"] = ar.material()
            streams.append(stream)
        if (effect, declaration, topology, buffer_index, flags) != (0, 0, 1, 0, 0):
            raise ValueError("Unsupported primitive profile")
        if len(lods) != 1 or len(streams) != 1:
            raise ValueError("Unexpected primitive count")
        stream = streams[0]
        if (stream["vertexBuffer"], stream["streamIndex"], stream["vertexOffset"]) != (0, 0, 0):
            raise ValueError("Unsupported vertex stream")
        lod = lods[0]
        subset = indices[lod["offset"]:lod["offset"] + lod["nIndices"]]
        if len(subset) != lod["nIndices"] or min(subset) < lod["minIndex"] or max(subset) >= lod["minIndex"] + lod["nVertices"]:
            raise ValueError("Primitive range mismatch")
        emitted = 0
        # Restart parity for each draw, retain parity through degenerate indices.
        for j in range(2, len(subset)):
            a, b, c = subset[j - 2:j + 1]
            if j % 2:
                a, b = b, a
            if a != b and b != c and c != a:
                triangles.extend((a, b, c))
                emitted += 1
        draws.append({"primitiveOffset": primitive_offset, "serializedEnd": ar.offset,
                      "topology": "triangle-strip", "topologyValue": topology,
                      "lod": lod, "streams": streams, "baseMaterial": base_material,
                      "instanceMaterial": instance_material, "blendState": blend_state,
                      "nondegenerateTriangles": emitted})

    position_bytes = b"".join(struct.pack("<fff", *p) for p in positions)
    triangle_bytes = struct.pack(f"<{len(triangles)}I", *triangles)
    result = {"fixtureOnly": True, "sha256": digest, "decodedBytes": len(data),
              "coordinateSpace": "object-local; no scene-node transform applied",
              "scenePayloadOrigin": SCENE_ORIGIN,
              "vertexBuffer": {"objectOffset": 2731, "count": vertex_count, "stride": stride,
                               "elements": elements, "elementOffsets": offsets, **vertex_blob},
              "indexBuffer": {"objectOffset": 4855, "count": index_count, "type": "uint16",
                              "minimum": min(indices), "maximum": max(indices), **index_blob},
              "bounds": {"min": [min(p[k] for p in positions) for k in range(3)],
                         "max": [max(p[k] for p in positions) for k in range(3)]},
              "draws": draws, "triangleCount": len(triangles) // 3,
              "geometryHashes": {
                  "positionsFloat32LittleEndianSha256": hashlib.sha256(position_bytes).hexdigest(),
                  "triangleIndicesUint32LittleEndianSha256": hashlib.sha256(triangle_bytes).hexdigest()}}
    if include_geometry:
        result["geometry"] = {"positions": positions, "stripIndices": indices,
                              "triangleListIndices": triangles}
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("model", nargs="?", type=Path,
                        default=Path("_work/model-probe/trafficcylinder.model"))
    parser.add_argument("--geometry", action="store_true")
    args = parser.parse_args()
    try:
        result = inspect(args.model.read_bytes(), args.geometry)
    except (OSError, ValueError, struct.error) as error:
        parser.exit(1, f"Mesh inspection failed: {error}\n")
    print(json.dumps(result, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
