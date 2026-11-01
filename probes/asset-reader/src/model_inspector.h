#pragma once
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif
// Inspect a complete decoded PC model file. Returned UTF-8 JSON is malloc-owned.
// This reads chunk headers only; it neither validates integrity nor renders a mesh.
char* model_inspect(const unsigned char* bytes, size_t available);
void model_free(void* pointer);
#ifdef __cplusplus
}
#endif
