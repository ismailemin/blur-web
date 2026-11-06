#pragma once
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
// Bounded sequential PC Scene decoder. Emits first RenderListNode's object-local
// base primitives, UV0, draw spans and supported shared-texture albedo bindings.
// Explicit partial traversal metadata: instances/world transforms not applied.
char* scene_inspect(const unsigned char* bytes, size_t available);
// Bounded metadata traversal across all loaded model resource blocks. Returns
// original texture LOD descriptors and exact descriptor/payload byte spans.
// No geometry, material, instance or runtime object is imported.
char* scene_resource_textures_inspect(const unsigned char* bytes, size_t available);
// Source ChunkInfo stream-range index from an original PC .levelrender file.
char* level_index_inspect(const unsigned char* level_bytes, size_t level_size);
// Bounded level Scene + two original companion-stream ranges. Block IDs must
// match the first LOD0 item of source ChunkInfo records and exact stored lengths.
// Emits direct LOD0 primitives bound to the selected geometry block only;
// instance/batch descriptions are parsed but their geometry is not applied.
char* level_mesh_inspect(const unsigned char* level_bytes, size_t level_size,
                         const unsigned char* geometry_bytes, size_t geometry_size,
                         const unsigned char* node_bytes, size_t node_size,
                         int32_t geometry_block, int32_t node_block);
// Instantiated first-RenderList first-instance proof. Traverses every preceding
// item in a stream chunk, applies only explicit constant affine g_mWorld, and
// emits transformed world-space LOD0 geometry for one instance.
char* level_instances_inspect(const unsigned char* level_bytes, size_t level_size,
                              const unsigned char* geometry_bytes, size_t geometry_size,
                              const unsigned char* node_bytes, size_t node_size,
                              int32_t geometry_block, int32_t node_block);
// Additive variant: emits every instance whose VB/IB bind the selected geometry
// block. Other-block instances are counted as omitted, not guessed. Instance
// UV0 (usage5/type8 on the POSITION stream) and the resolved static g_tAlbedo
// resource identity are exported with a per-draw FNV-1a 64 UV hash; texture
// format, alpha, blend, shader, sampler and higher LODs remain unapplied.
char* level_instances_all_inspect(const unsigned char* level_bytes, size_t level_size,
                                  const unsigned char* geometry_bytes, size_t geometry_size,
                                  const unsigned char* node_bytes, size_t node_size,
                                  int32_t geometry_block, int32_t node_block);
// Additive bundle variant for one CullNode group whose member draws bind VB/IB
// blocks located in more than one supplied geometry chunk. `geometry_blocks[k]`
// names the resource block supplied by `geometry_bytes[k]`; a group with any
// member whose VB/IB block is not supplied is withheld as incomplete.
char* level_instances_bundle_inspect(const unsigned char* level_bytes, size_t level_size,
                                     const unsigned char* node_bytes, size_t node_size,
                                     int32_t node_block,
                                     const int32_t* geometry_blocks,
                                     const unsigned char* const* geometry_bytes,
                                     const size_t* geometry_sizes,
                                     size_t geometry_count);
void scene_free(void* pointer);
#ifdef __cplusplus
}
#endif
