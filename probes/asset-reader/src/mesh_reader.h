#pragma once
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif
// Inspect an already decompressed PC model. This initial decoder accepts only
// the SHA256-identified trafficcylinder fixture, and emits object-local render
// vertices and triangle-list indices. Returned JSON is malloc-owned.
char* mesh_inspect(const unsigned char* bytes, size_t available);
void mesh_free(void* pointer);
#ifdef __cplusplus
}
#endif
