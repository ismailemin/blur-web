cmake_minimum_required(VERSION 3.25)
project(BlurNetLayoutProbe LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
enable_testing()

# No game header is included: src/wire_decls.h is a traceable transcription of
# the upstream declarations (see tests/check_decls.py).
function(net_layout_warnings target)
  if(MSVC)
    target_compile_options(${target} PRIVATE /W4 /permissive-)
  else()
    target_compile_options(${target} PRIVATE -Wall -Wextra -Wpedantic)
  endif()
endfunction()

add_library(net_layout_core STATIC src/probe_core.cpp)
target_include_directories(net_layout_core PUBLIC src)
if(MSVC)
  target_compile_definitions(net_layout_core PUBLIC WIRE_PROBE_FLAGS=native-msvc-x64-wchar2)
else()
  target_compile_definitions(net_layout_core PUBLIC WIRE_PROBE_FLAGS=native-other)
endif()
net_layout_warnings(net_layout_core)

add_executable(net_layout_probe src/probe_main.cpp)
target_link_libraries(net_layout_probe PRIVATE net_layout_core)
if(MSVC)
  # fopen is the portable writer; the CRT deprecation shim is not wanted here.
  target_compile_definitions(net_layout_probe PRIVATE _CRT_SECURE_NO_WARNINGS)
endif()
net_layout_warnings(net_layout_probe)

add_test(NAME net_layout_selftest COMMAND net_layout_probe --selftest)
