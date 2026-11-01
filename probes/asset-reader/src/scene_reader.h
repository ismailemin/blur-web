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
void scene_free(void* pointer);
#ifdef __cplusplus
}
#endif
