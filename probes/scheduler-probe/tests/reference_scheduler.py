#!/usr/bin/env python3
"""Independent Python model of the T-005c fixed-step driver.

This file is a from-scratch reimplementation of the rule documented in
docs/work/analysis/t005-scheduler-design.md §4.3 and evidenced against
upstream ApplicationPC.cpp:480-590. It deliberately shares no code with the C++
probe: the agreement between the two is the test.

Usage:
    python probes/scheduler-probe/tests/reference_scheduler.py --out reference.json
"""
from __future__ import annotations

import argparse
import json
import platform
import struct
from pathlib import Path

MASK64 = (1 << 64) - 1

# Documented rule parameters, repeated here on purpose (not imported).
STEP_HZ = 60
US_PER_SECOND = 1_000_000
MAX_TICKS_PER_FRAME = 4
PAUSE_THRESHOLD_US = 250_000
AU_PER_US = STEP_HZ
AU_PER_STEP = US_PER_SECOND

K_TICK = 1 << 0
K_ZERO_TICK = 1 << 1
K_CAPPED = 1 << 2
K_BACKLOG_DROP = 1 << 3
K_PAUSED = 1 << 4
K_DT_REWIND = 1 << 5
K_DELTA_ZERO = 1 << 6
K_BASELINE = 1 << 7

ACCEL = (1, 2, 3, 5, 8, 13, 21, 34, 21, 13, 8, 5, 3, 2, 1, 0)
JITTER_TABLE = (7000, 7500, 8000, 8500, 9000, 9500, 8500, 7500,
                6500, 7000, 8000, 9000, 10000, 8500, 7500, 6000)


# --------------------------------------------------------------------------- #
# ID generation
# --------------------------------------------------------------------------- #
class Driver:
    """Exact integer fixed-step driver."""

    def __init__(self, drop_backlog: bool = True) -> None:
        self.drop_backlog = drop_backlog
        self.acc_units = 0
        self.last_us = 0
        self.has_baseline = False
        self.frames = 0

    def reset(self, now_us: int) -> None:
        self.acc_units = 0
        self.last_us = now_us
        self.has_baseline = True
        self.frames = 0

    def advance_to(self, now_us: int) -> dict:
        if not self.has_baseline:
            self.has_baseline = True
            self.last_us = now_us
            self.acc_units = 0
            self.frames += 1
            return {
                "dtUs": 0, "requestedTicks": 0, "ticks": 0,
                "accUnits": 0, "droppedUnits": 0, "droppedTicks": 0,
                "flags": K_BASELINE | K_DELTA_ZERO | K_ZERO_TICK,
            }
        delta_us = now_us - self.last_us
        self.last_us = now_us
        return self.advance_by(delta_us)

    def advance_by(self, delta_us: int) -> dict:
        flags = 0
        effective = delta_us
        if effective < 0:
            flags |= K_DT_REWIND
            effective = 0
        if effective == 0:
            flags |= K_DELTA_ZERO

        if effective > PAUSE_THRESHOLD_US:
            flags |= K_PAUSED
            self.acc_units = 0
        else:
            self.acc_units += effective * AU_PER_US

        requested = self.acc_units // AU_PER_STEP
        ticks = requested
        if ticks > MAX_TICKS_PER_FRAME:
            ticks = MAX_TICKS_PER_FRAME
            flags |= K_CAPPED

        dropped_units = 0
        dropped_ticks = 0
        if ticks > 0:
            self.acc_units -= ticks * AU_PER_STEP
            if self.drop_backlog and self.acc_units >= AU_PER_STEP:
                dropped_units = self.acc_units
                dropped_ticks = self.acc_units // AU_PER_STEP
                self.acc_units = 0
                flags |= K_BACKLOG_DROP
            flags |= K_TICK
        else:
            flags |= K_ZERO_TICK

        self.frames += 1
        return {
            "dtUs": effective, "requestedTicks": requested, "ticks": ticks,
            "accUnits": self.acc_units, "droppedUnits": dropped_units,
            "droppedTicks": dropped_ticks, "flags": flags,
        }


# --------------------------------------------------------------------------- #
# Trace generation (integer only, matches the C++ helpers)
# --------------------------------------------------------------------------- #
def timestamps_from_rate(frames: int, hz: int, us_per_second: int = US_PER_SECOND) -> list[int]:
    return [(i * us_per_second) // hz for i in range(frames + 1)]


def rate_deltas(frames: int, hz: int, us_per_second: int = US_PER_SECOND) -> list[int]:
    timestamps = timestamps_from_rate(frames, hz, us_per_second)
    return [timestamps[i + 1] - timestamps[i] for i in range(frames)]


def timestamps_from_deltas(deltas: list[int]) -> list[int]:
    timestamps = [0]
    now = 0
    for delta in deltas:
        now += delta
        timestamps.append(now)
    return timestamps


def jitter_deltas(frames: int) -> list[int]:
    return [JITTER_TABLE[i & 15] for i in range(frames)]


def build_scenarios() -> list[dict]:
    scenarios: list[dict] = []
    scenarios.append({
        "name": "hz144-600f",
        "note": "600 rendered frames at 144 Hz; 600 deltas of 6944/6945 us",
        "timestampsUs": timestamps_from_rate(600, 144),
        "dropBacklog": True,
    })
    scenarios.append({
        "name": "hz30-300f",
        "note": "300 rendered frames at 30 Hz; deltas of 33333/33334 us",
        "timestampsUs": timestamps_from_rate(300, 30),
        "dropBacklog": True,
    })

    deltas = rate_deltas(400, 144)
    deltas[200] = 250_000
    scenarios.append({
        "name": "hitch-250ms-400f",
        "note": "400 frames at 144 Hz with frame 200's delta replaced by exactly "
                "250000 us (pause threshold boundary, not a pause)",
        "timestampsUs": timestamps_from_deltas(deltas),
        "dropBacklog": True,
    })

    deltas = rate_deltas(400, 144)
    deltas[200] = 5_000_000
    scenarios.append({
        "name": "tabgap-5s-400f",
        "note": "400 frames at 144 Hz with frame 200's delta replaced by 5000000 us "
                "(background tab: pause rule must drop the accumulator)",
        "timestampsUs": timestamps_from_deltas(deltas),
        "dropBacklog": True,
    })

    scenarios.append({
        "name": "jitter-8ms-500f",
        "note": "500 frames of a fixed 16-entry delta pattern; a full 16-frame "
                "cycle averages exactly 8000 us and the 500-frame total is 3999000 us",
        "timestampsUs": timestamps_from_deltas(jitter_deltas(500)),
        "dropBacklog": True,
    })
    scenarios.append({
        "name": "equal5s-600f",
        "note": "the same 5 s of simulated time delivered as 600 frames (120 Hz)",
        "timestampsUs": timestamps_from_rate(600, 120),
        "dropBacklog": True,
    })
    scenarios.append({
        "name": "equal5s-150f",
        "note": "the same 5 s of simulated time delivered as 150 frames (30 Hz)",
        "timestampsUs": timestamps_from_rate(150, 30),
        "dropBacklog": True,
    })
    scenarios.append({
        "name": "equal5s-100f",
        "note": "the same 5 s of simulated time delivered as 100 frames (20 Hz); "
                "3 ticks per frame, clear of the 4-tick cap",
        "timestampsUs": timestamps_from_rate(100, 20),
        "dropBacklog": True,
    })
    scenarios.append({
        "name": "capboundary-15hz-75f",
        "note": "5 s at 15 Hz. 4 ticks is 66666.67 us, so integer-microsecond "
                "timestamps of 66666/66667 us accumulate a near-full-tick carry; "
                "every third frame requests 5 ticks, the cap runs 4 and the "
                "ApplicationPC backlog clamp discards 1. Executed + dropped still "
                "equals requested; the lost ticks are the measured cost of the cap.",
        "timestampsUs": timestamps_from_rate(75, 15),
        "dropBacklog": True,
    })
    scenarios.append({
        "name": "keepbacklog-200ms-5f",
        "note": "dropBacklog=false policy comparison: 5 frames of 200000 us keep the "
                "unconsumed backlog, so alpha saturates at 1 and the accumulator grows",
        "timestampsUs": timestamps_from_deltas([200_000] * 5),
        "dropBacklog": False,
    })
    return scenarios


# --------------------------------------------------------------------------- #
# Deterministic state
# --------------------------------------------------------------------------- #
def sim_step(pos: int, vel: int, tick_index: int) -> tuple[int, int]:
    vel = (vel + ACCEL[tick_index & 15]) & MASK64
    pos = (pos + vel) & MASK64
    return pos, vel


def fnv1a64_mix(hash_value: int, value: int) -> int:
    for index in range(8):
        hash_value ^= (value >> (8 * index)) & 0xFF
        hash_value = (hash_value * 0x100000001B3) & MASK64
    return hash_value


def fnv1a64_seed() -> int:
    return 0xCBF29CE484222325


def hash_state(pos: int, vel: int) -> int:
    return fnv1a64_mix(fnv1a64_mix(fnv1a64_seed(), pos), vel)


def alpha_bits(num: int, den: int) -> str:
    bits = struct.unpack("<Q", struct.pack("<d", num / den))[0]
    return f"{bits:016x}"


def run_scenario(scenario: dict) -> dict:
    driver = Driver(drop_backlog=scenario["dropBacklog"])
    timestamps = scenario["timestampsUs"]
    frames = len(timestamps) - 1
    driver.reset(timestamps[0])

    samples = []
    pos = 0
    vel = 0
    previous_pos = 0
    tick_index = 0

    totals = {
        "totalTicks": 0, "totalRequestedTicks": 0, "maxTicksInFrame": 0,
        "cappedFrames": 0, "pausedFrames": 0, "zeroTickFrames": 0,
        "rewindFrames": 0, "backlogDropFrames": 0, "backlogDropTicks": 0,
    }

    for index in range(1, frames + 1):
        sample = driver.advance_to(timestamps[index])
        samples.append(sample)
        for _ in range(sample["ticks"]):
            previous_pos = pos
            tick_index += 1
            pos, vel = sim_step(pos, vel, tick_index)
        totals["totalTicks"] += sample["ticks"]
        totals["totalRequestedTicks"] += sample["requestedTicks"]
        totals["maxTicksInFrame"] = max(totals["maxTicksInFrame"], sample["ticks"])
        flags = sample["flags"]
        if flags & K_CAPPED:
            totals["cappedFrames"] += 1
        if flags & K_PAUSED:
            totals["pausedFrames"] += 1
        if flags & K_ZERO_TICK:
            totals["zeroTickFrames"] += 1
        if flags & K_DT_REWIND:
            totals["rewindFrames"] += 1
        if flags & K_BACKLOG_DROP:
            totals["backlogDropFrames"] += 1
            totals["backlogDropTicks"] += sample["droppedTicks"]

    last = samples[-1] if samples else {"accUnits": 0}
    alpha_num = min(last["accUnits"], AU_PER_STEP)
    alpha_den = AU_PER_STEP
    interp_num = (previous_pos * alpha_den + (pos - previous_pos) * alpha_num) & MASK64
    render_hash = fnv1a64_mix(fnv1a64_mix(fnv1a64_seed(), interp_num), alpha_num)

    duration_us = timestamps[-1] - timestamps[0] if frames else 0
    deltas = [sample["dtUs"] for sample in samples]

    return {
        "name": scenario["name"],
        "note": scenario["note"],
        "dropBacklog": scenario["dropBacklog"],
        "frames": frames,
        "durationUs": duration_us,
        "deltaUs": {
            "min": min(deltas) if deltas else 0,
            "max": max(deltas) if deltas else 0,
        },
        **totals,
        "finalAccUnits": last["accUnits"],
        "finalAlphaNum": alpha_num,
        "finalAlphaDen": alpha_den,
        "finalAlphaBits": alpha_bits(alpha_num, alpha_den),
        "state": {"pos": pos, "vel": vel, "hash": f"0x{hash_state(pos, vel):016x}"},
        "render": {
            "interpNum": interp_num,
            "interpDen": alpha_den,
            "alphaNum": alpha_num,
            "hash": f"0x{render_hash:016x}",
        },
        "frameDeltas": deltas,
        "frameTicks": [sample["ticks"] for sample in samples],
        "frameAccUnits": [sample["accUnits"] for sample in samples],
        "frameFlags": [sample["flags"] for sample in samples],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    summaries = [run_scenario(scenario) for scenario in build_scenarios()]

    alpha_in_range = all(0 <= s["finalAlphaNum"] <= s["finalAlphaDen"] for s in summaries)
    accumulator_in_range = all(
        all(0 <= value and (not s["dropBacklog"] or value <= AU_PER_STEP)
            for value in s["frameAccUnits"])
        for s in summaries)
    cap_respected = all(s["maxTicksInFrame"] <= MAX_TICKS_PER_FRAME for s in summaries)

    document = {
        "schema": "blur-scheduler-probe/1",
        "build": {
            "target": "python-reference",
            "compiler": f"python {platform.python_version()}",
            "flags": "integer model, no floating point in the accumulator",
        },
        "config": {
            "stepHz": STEP_HZ,
            "usPerSecond": US_PER_SECOND,
            "auPerUs": AU_PER_US,
            "auPerStep": AU_PER_STEP,
            "maxTicksPerFrame": MAX_TICKS_PER_FRAME,
            "pauseThresholdUs": PAUSE_THRESHOLD_US,
            "defaultDropBacklog": True,
            "timeBase": "integer microseconds; accumulator in 1/stepHz microsecond units",
            "pauseRule": "delta > pauseThresholdUs is a pause: accumulator cleared, "
                         "delta discarded",
        },
        "checks": {
            "alphaInRange": alpha_in_range,
            "accumulatorInRange": accumulator_in_range,
            "capRespected": cap_respected,
        },
        "scenarios": summaries,
    }

    Path(args.out).write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
