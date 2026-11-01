#pragma once
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif
// bytes is a prefix of a file whose total size is logical_file_size.
// JSON is UTF-8, malloc-owned; release it with pak_free. No payload is decoded.
char* pak_inspect(const unsigned char* bytes, size_t available, double logical_file_size);
void pak_free(void* pointer);
#ifdef __cplusplus
}
#endif
