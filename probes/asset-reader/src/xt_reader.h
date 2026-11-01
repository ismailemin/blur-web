#pragma once
#include <stddef.h>
#ifdef __cplusplus
extern "C" {
#endif
// Inspect decoded little-endian PC FLSK v1/v2 metadata. Never casts serialized
// bytes to native pointers or creates game reflection objects. Result is malloc
// owned UTF-8 JSON; payload pointer/array fixups are intentionally not imported.
char* xt_inspect(const unsigned char* bytes, size_t available);
void xt_free(void* pointer);
#ifdef __cplusplus
}
#endif
