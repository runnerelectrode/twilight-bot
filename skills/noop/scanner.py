#!/usr/bin/env python3
"""noop scanner — replies `noop` for every tick. M0 verification only."""
from skill_sdk import read_tick, write_noop


def main() -> None:
    for tick in read_tick():
        write_noop(tick["tick_id"], "noop skill — m0 placeholder")


if __name__ == "__main__":
    main()
