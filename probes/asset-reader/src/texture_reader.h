#pragma once
#include <stddef.h>
#ifdef __cplusplus
extern "C" {
#endif
// Decoded PC .texture container, not XT game data. Returns malloc-owned JSON.
char* texture_inspect(const unsigned char* bytes, size_t available);
// Embedded PC TextureDesc followed immediately by its complete texel mip chain.
// No FileBlock headers or standalone flags are present in this representation.
char* texture_raw_inspect(const unsigned char* bytes, size_t available);
void texture_free(void* pointer);
#ifdef __cplusplus
}
#endif
