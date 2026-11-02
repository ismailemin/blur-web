cmake_minimum_required(VERSION 3.25)
project(BlurRangeFileProbe LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

enable_testing()

add_library(range_file STATIC
  src/range_file.cpp
  src/pak_index_range.cpp
  src/level_index_range.cpp)
target_include_directories(range_file PUBLIC src)

add_executable(range_probe src/range_probe_cli.cpp)
target_link_libraries(range_probe PRIVATE range_file)

add_executable(range_file_tests tests/range_file_tests.cpp)
target_link_libraries(range_file_tests PRIVATE range_file)

if(MSVC)
  foreach(target range_file range_probe range_file_tests)
    target_compile_options(${target} PRIVATE /W4 /permissive-)
  endforeach()
else()
  foreach(target range_file range_probe range_file_tests)
    target_compile_options(${target} PRIVATE -Wall -Wextra -Wpedantic)
  endforeach()
endif()

add_test(NAME range_file_unit COMMAND range_file_tests)
