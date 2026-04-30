"""Stdio JSON-lines protocol between the TS host and a Python skill.

Host writes one JSON object per line on stdin. Skill writes one JSON
object per line on stdout. Anything on stderr is treated as a log line
by the host.
"""
from __future__ import annotations
import json
import sys
from typing import Any, Iterator


def read_tick() -> Iterator[dict[str, Any]]:
    """Yield one tick dict at a time from stdin until EOF."""
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError as e:
            print(f"skill_sdk: bad json on stdin: {e}", file=sys.stderr, flush=True)
            continue
        if obj.get("type") != "tick":
            print(f"skill_sdk: unexpected message type: {obj.get('type')!r}", file=sys.stderr, flush=True)
            continue
        yield obj


def _write(obj: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def write_intent(intent: dict[str, Any]) -> None:
    if intent.get("type") != "intent":
        intent = {"type": "intent", **intent}
    _write(intent)


def write_noop(tick_id: str, reason: str) -> None:
    _write({"type": "noop", "tick_id": tick_id, "reason": reason})
