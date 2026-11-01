# Larger source-bound level preview candidates

The current level preview API can already show substantially larger original
geometry than the initial river344vertex/208triangle pair. This audit found
**nine supported correlated pairs** using17native probes across river, showroom
and Barcelona bowl. It did not modify any game data or the C++ reader.

The first small fixture remains unchanged in `_work/level-chunk/` for regression.

## Selection method and limits

`tools/inspect_level_candidates.py` examines only source ChunkInfo records whose
first item is LOD0 and whose prerequisite list is empty. Prefixes distinguish
geometry resources from node-only resources. It sequentially reads each candidate
node's first RenderList, then correlates its declaration-selected POSITION and
index source-block IDs with actual first-LOD0 geometry records. There is no
all-pairs search, marker scan, odd/even block inference, or whole-IB draw guess.

The scan found46related pairs in river, one in showroom and six in bowl. It
selected up to10per level by serialized direct source-index count; these17pairs
were checked with the current native `level_inspect` API. Every native success
was compared with independently converted Python positions/indices and draw
count. Each source chunk is capped16MiB and every source range is checked against
its companion file. The run read19,488,640stream bytes and parsed87node chunks
without a Python format error. It is a bounded candidate audit, not an exhaustive
proof of the globally largest possible mesh.

Ranking uses actual triangle area with normals near the Y axis, then actual
triangle count. This identifies **floor/road-like geometry only as an inference**:
roofs and other flat structures can also rank highly. Original node names in
these cases are empty, so no original semantic name proves that a candidate is
the drivable road. Browser inspection and runtime/physics data remain separate.

## First broader river selection

Recommended development preset: river geometry block88, node block283. Its
native output is17,782vertices,9,343triangles and95direct draw spans. About91.4%
of triangle area is near-horizontal. Serialized source bounds:

- X944.0374..2477.9229
- Y-4.2583..39.1427
- Z2205.9336..3237.1702

The source ChunkInfo ranges are geometry chunk136(offset54,616,064,stored589,824)
and node chunk68(offset3,737,600,stored104,448). Browser code should discover these
ranges from `level_index_inspect`, selecting first LOD0 IDs88/283; these recorded
offsets are evidence, not a replacement for runtime index parsing.

Canonical geometry hashes:

- F32LE positions: `8fceaebda77bfa4553ab56ac8b39bfad9bb1451eb05f0f866a467f559c1f8d86`
- U32LE triangle indices: `8ec13882b653ca5dda2788f7b3a428ea165f8bc8eb2a7586a86aeea9727e2576`

Frozen original input files and independent output:

`_work/level-candidates/probes/00-usa_la_river-g88-n283/{geometry.chunk,node.chunk,reference.json}`.

## Other verified candidates

| Level | Geometry/node block IDs | Vertices | Triangles | Direct draws | Probe directory suffix |
| --- | --- | ---: | ---: | ---: | --- |
| River | 104/227 | 16,694 | 7,903 | 52 | `03-usa_la_river-g104-n227` |
| River | 56/289 | 14,508 | 9,824 | 49 | `08-usa_la_river-g56-n289` |
| River | 92/283 | 14,380 | 8,504 | 70 | `10-usa_la_river-g92-n283` |
| River | 80/227 | 16,483 | 9,561 | 28 | `07-usa_la_river-g80-n227` |
| Barcelona bowl | 32/33 | 4,639 | 3,187 | 24 | `16-spa_barcelona_bowl_multiplayer-g32-n33` |
| Barcelona bowl | 8/29 | 14,488 | 8,905 | 35 | `09-spa_barcelona_bowl_multiplayer-g8-n29` |
| Barcelona bowl | 7/33 | 10,685 | 8,554 | 69 | `15-spa_barcelona_bowl_multiplayer-g7-n33` |
| Showroom | 3/10 | 11,590 | 7,987 | 95 | `14-showroom-g3-n10` |

All directories are under `_work/level-candidates/probes/`. Showroom is an actual
supported alternative; the earlier geometry block1 with prerequisites is not
needed for this block3/node10 preview. The showroom pair reads geometry from
offset178,176,stored1,366,016 and node data from offset20,480,stored38,912.

Eight tested related pairs returned explicit `Unsupported position vertex
format` errors: river51/237,98/199,44/285,46/303,67/259 and bowl13/31,21/31,12/31.
This audit records the current rejection; it does not infer a shader conversion
or change that format's support. Source descriptor/shader work can address those
separately. Additional prerequisite-bearing and ambiguous/unavailable source
records were excluded before native probing, not silently considered supported.

## Machine-readable handoff

`_work/level-candidates/report.json` is compact metadata, with:

- `topCandidates[0..2]`: broad river88/283,104/227 and56/289 selections.
- `allValidCandidateSummaries`: all nine supported pairs, including showroom.
- Per candidate: `level`, `geometryBlock`, `nodeBlock`, `geometryChunkIndex`,
  `nodeChunkIndex`, `geometryRange`, `nodeRange`, `vertexCount`, `triangleCount`,
  `drawCount`, `bounds`, `flatness`, original-input hashes, canonical-output hashes
  and `stageDirectory`.
- Each probe directory's `reference.json`: flat `positions`, `indices`, `draws`,
  counts, bounds, `positionsFloat32LESha256`, `indicesUint32LESha256`.
- `probes`: native supported/unsupported results. `parseErrorCount`: zero.

All successes retain the native API's explicit scope: selected geometry block,
first node-chunk RenderList direct LOD0 primitives only. Instances, materials,
visibility, transforms and gameplay are not imported. These candidates can
improve the browser visual proof without claiming a complete track or race.

The authoritative serializer paths are the same as `level-chunk-format.md`:
`RenderLevel.cpp`, `WorldRender.cpp`, target `archive.cpp`,
`renderingdata/noninterface/archive.inl`, `streamdata.cpp`, `streammanager.cpp`
and `context.cpp`. The new diagnostic reuses the independently source-shaped
Python readers in `inspect_car_level_assets.py` and `inspect_level_chunk.py`.
