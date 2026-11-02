cmake_minimum_required(VERSION 3.25)
project(BlurCollisionOracle LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

enable_testing()

add_library(collision_oracle STATIC
  src/level_physics.cpp
  src/queries.cpp
  src/query_table.cpp
  src/oracle_run.cpp)
target_include_directories(collision_oracle PUBLIC src)

add_executable(collision_oracle_cli src/probe_main.cpp)
target_link_libraries(collision_oracle_cli PRIVATE collision_oracle)

add_executable(collision_oracle_tests tests/oracle_tests.cpp)
target_link_libraries(collision_oracle_tests PRIVATE collision_oracle)

# The numeric contract must be identical on both targets: no contraction, no
# fast-math, IEEE single precision only. The native and wasm builds both record
# this string next to their hashes.
target_compile_definitions(collision_oracle PUBLIC
  "ORACLE_NUMERIC_CONTRACT=\"no-fma,no-fast-math,binary32\"")

if(MSVC)
  foreach(target collision_oracle collision_oracle_cli collision_oracle_tests)
    target_compile_options(${target} PRIVATE /W4 /permissive- /fp:precise)
  endforeach()
else()
  foreach(target collision_oracle collision_oracle_cli collision_oracle_tests)
    target_compile_options(${target} PRIVATE -Wall -Wextra -Wpedantic -ffp-contract=off -fno-fast-math)
  endforeach()
endif()

add_test(NAME collision_oracle_selftest COMMAND collision_oracle_cli --selftest)
add_test(NAME collision_oracle_unit COMMAND collision_oracle_tests)
