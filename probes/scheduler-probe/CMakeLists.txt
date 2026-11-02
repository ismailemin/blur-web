cmake_minimum_required(VERSION 3.25)
project(BlurSchedulerProbe LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
enable_testing()

function(scheduler_probe_warnings target)
  if(MSVC)
    target_compile_options(${target} PRIVATE /W4 /permissive-)
  else()
    target_compile_options(${target} PRIVATE -Wall -Wextra -Wpedantic)
  endif()
endfunction()

# Numeric policy is recorded next to every hash. The wasm build passes the same
# macro from tests/run_scheduler_probe.py.
add_library(scheduler_fixed_step STATIC
  src/fixed_step.cpp
  src/sim_state.cpp
  src/scenarios.cpp)
target_include_directories(scheduler_fixed_step PUBLIC src)
if(MSVC)
  target_compile_definitions(scheduler_fixed_step PUBLIC
    "PROBE_FLAGS_STRING=\"/W4 /permissive- /fp:precise\"")
else()
  target_compile_definitions(scheduler_fixed_step PUBLIC
    "PROBE_FLAGS_STRING=\"-Wall -Wextra -Wpedantic -O2 -ffp-contract=off\"")
endif()
scheduler_probe_warnings(scheduler_fixed_step)

add_executable(scheduler_probe src/probe_main.cpp)
target_link_libraries(scheduler_probe PRIVATE scheduler_fixed_step)
scheduler_probe_warnings(scheduler_probe)

add_executable(scheduler_probe_tests tests/fixed_step_tests.cpp)
target_link_libraries(scheduler_probe_tests PRIVATE scheduler_fixed_step)
scheduler_probe_warnings(scheduler_probe_tests)

add_test(NAME scheduler_fixed_step COMMAND scheduler_probe_tests)
add_test(NAME scheduler_probe_selftest COMMAND scheduler_probe --selftest)
